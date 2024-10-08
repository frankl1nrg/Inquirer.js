/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import readline from 'node:readline';
import {
  defer,
  EMPTY,
  from,
  of,
  concatMap,
  filter,
  reduce,
  isObservable,
  Observable,
  lastValueFrom,
} from 'rxjs';
import runAsync from 'run-async';
import MuteStream from 'mute-stream';
import { AbortPromptError } from '@inquirer/core';
import type { InquirerReadline } from '@inquirer/type';
import ansiEscapes from 'ansi-escapes';
import type {
  Answers,
  AnyQuestion,
  AsyncGetterFunction,
  PromptSession,
  StreamOptions,
} from '../types.mjs';

export const _ = {
  set: (obj: Record<string, unknown>, path: string = '', value: unknown): void => {
    let pointer = obj;
    path.split('.').forEach((key, index, arr) => {
      if (key === '__proto__' || key === 'constructor') return;

      if (index === arr.length - 1) {
        pointer[key] = value;
      } else if (!(key in pointer) || typeof pointer[key] !== 'object') {
        pointer[key] = {};
      }

      pointer = pointer[key] as Record<string, unknown>;
    });
  },
  get: (
    obj: object,
    path: string | number | symbol = '',
    defaultValue?: unknown,
  ): any => {
    const travel = (regexp: RegExp) =>
      String.prototype.split
        .call(path, regexp)
        .filter(Boolean)
        .reduce(
          // @ts-expect-error implicit any on res[key]
          (res, key) => (res !== null && res !== undefined ? res[key] : res),
          obj,
        );
    const result = travel(/[,[\]]+?/) || travel(/[,.[\]]+?/);
    return result === undefined || result === obj ? defaultValue : result;
  },
};

/**
 * Resolve a question property value if it is passed as a function.
 * This method will overwrite the property on the question object with the received value.
 */
async function fetchAsyncQuestionProperty<
  A extends Answers,
  Prop extends keyof Q,
  Q extends AnyQuestion<A>,
>(
  question: Q,
  prop: Prop,
  answers: A,
): Promise<Exclude<Q[Prop], AsyncGetterFunction<any, any>>> {
  type RawValue = Exclude<Q[Prop], AsyncGetterFunction<any, any>>;

  const propGetter = question[prop];
  if (typeof propGetter === 'function') {
    return runAsync(propGetter as (...args: unknown[]) => Promise<RawValue>)(answers);
  }

  return propGetter as RawValue;
}

export interface PromptBase {
  /**
   * Runs the prompt.
   *
   * @returns
   * The result of the prompt.
   */
  run(): Promise<any>;
}

/**
 * Provides the functionality to initialize new prompts.
 */
export interface LegacyPromptConstructor {
  /**
   * Initializes a new instance of a prompt.
   *
   * @param question
   * The question to prompt.
   *
   * @param readLine
   * An object for reading from the command-line.
   *
   * @param answers
   * The answers provided by the user.
   */
  new (
    question: any,
    readLine: InquirerReadline,
    answers: Record<string, any>,
  ): PromptBase;
}

export type PromptFn<Value = any, Config = any> = (
  config: Config,
  context?: StreamOptions,
) => Promise<Value>;

/**
 * Provides a set of prompt-constructors.
 */
export type PromptCollection = Record<string, PromptFn | LegacyPromptConstructor>;

class TTYError extends Error {
  override name = 'TTYError';
  isTtyError = true;
}

function setupReadlineOptions(opt: StreamOptions) {
  // Inquirer 8.x:
  // opt.skipTTYChecks = opt.skipTTYChecks === undefined ? opt.input !== undefined : opt.skipTTYChecks;
  opt.skipTTYChecks = opt.skipTTYChecks === undefined ? true : opt.skipTTYChecks;

  // Default `input` to stdin
  const input = opt.input || process.stdin;

  // Check if prompt is being called in TTY environment
  // If it isn't return a failed promise
  // @ts-expect-error: ignore isTTY type error
  if (!opt.skipTTYChecks && !input.isTTY) {
    throw new TTYError(
      'Prompts can not be meaningfully rendered in non-TTY environments',
    );
  }

  // Add mute capabilities to the output
  const ms = new MuteStream();
  ms.pipe(opt.output || process.stdout);
  const output = ms;

  return {
    terminal: true,
    ...opt,
    input,
    output,
  };
}

function isQuestionArray<A extends Answers>(
  questions: PromptSession<A>,
): questions is AnyQuestion<A>[] {
  return Array.isArray(questions);
}

function isQuestionMap<A extends Answers>(
  questions: PromptSession<A>,
): questions is Record<string, Omit<AnyQuestion<A>, 'name'>> {
  return Object.values(questions).every(
    (maybeQuestion) =>
      typeof maybeQuestion === 'object' &&
      !Array.isArray(maybeQuestion) &&
      maybeQuestion != null,
  );
}

function isPromptConstructor(
  prompt: PromptFn | LegacyPromptConstructor,
): prompt is LegacyPromptConstructor {
  return Boolean(
    prompt.prototype &&
      'run' in prompt.prototype &&
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      typeof prompt.prototype.run === 'function',
  );
}

/**
 * Base interface class other can inherits from
 */
export default class PromptsRunner<A extends Answers> {
  private prompts: PromptCollection;
  answers: Partial<A> = {};
  process: Observable<any> = EMPTY;
  private abortController: AbortController = new AbortController();
  private opt: StreamOptions;
  rl?: InquirerReadline;

  constructor(prompts: PromptCollection, opt: StreamOptions = {}) {
    this.opt = opt;
    this.prompts = prompts;
  }

  async run(questions: PromptSession<A>, answers?: Partial<A>): Promise<A> {
    this.abortController = new AbortController();

    // Keep global reference to the answers
    this.answers = typeof answers === 'object' ? { ...answers } : {};

    let obs: Observable<AnyQuestion<A>>;
    if (isQuestionArray(questions)) {
      obs = from(questions);
    } else if (isObservable(questions)) {
      obs = questions;
    } else if (isQuestionMap(questions)) {
      // Case: Called with a set of { name: question }
      obs = from(
        Object.entries(questions).map(([name, question]): AnyQuestion<A> => {
          return Object.assign({}, question, { name });
        }),
      );
    } else {
      // Case: Called with a single question config
      obs = from([questions]);
    }

    this.process = obs.pipe(
      concatMap((question) =>
        of(question).pipe(
          concatMap((question) =>
            from(
              this.shouldRun(question).then((shouldRun: boolean | void) => {
                if (shouldRun) {
                  return question;
                }
                return;
              }),
            ).pipe(filter((val) => val != null)),
          ),
          concatMap((question) => defer(() => from(this.fetchAnswer(question)))),
        ),
      ),
    );

    return lastValueFrom(
      this.process.pipe(
        reduce((answersObj, answer: { name: string; answer: unknown }) => {
          _.set(answersObj, answer.name, answer.answer);
          return answersObj;
        }, this.answers),
      ),
    )
      .then(() => this.answers as A)
      .finally(() => this.close());
  }

  private prepareQuestion = async (question: AnyQuestion<A>) => {
    const [message, defaultValue, resolvedChoices] = await Promise.all([
      fetchAsyncQuestionProperty(question, 'message', this.answers),
      fetchAsyncQuestionProperty(question, 'default', this.answers),
      fetchAsyncQuestionProperty(question, 'choices', this.answers),
    ]);

    let choices;
    if (Array.isArray(resolvedChoices)) {
      choices = resolvedChoices.map((choice: unknown) => {
        if (typeof choice === 'string' || typeof choice === 'number') {
          return { name: choice, value: choice };
        } else if (
          typeof choice === 'object' &&
          choice != null &&
          !('value' in choice) &&
          'name' in choice
        ) {
          return { ...choice, value: choice.name };
        }
        return choice;
      });
    }

    return Object.assign({}, question, {
      message,
      default: defaultValue,
      choices,
      type: question.type in this.prompts ? question.type : 'input',
    });
  };

  private fetchAnswer = async (rawQuestion: AnyQuestion<A>) => {
    const question = await this.prepareQuestion(rawQuestion);
    const prompt = this.prompts[question.type];

    if (prompt == null) {
      throw new Error(`Prompt for type ${question.type} not found`);
    }

    let cleanupSignal: (() => void) | undefined;

    const promptFn: PromptFn<A> = isPromptConstructor(prompt)
      ? (q, { signal } = {}) =>
          new Promise<A>((resolve, reject) => {
            const rl = readline.createInterface(
              setupReadlineOptions(this.opt),
            ) as InquirerReadline;
            rl.resume();

            const onClose = () => {
              process.removeListener('exit', this.onForceClose);
              rl.removeListener('SIGINT', this.onForceClose);
              rl.setPrompt('');
              rl.output.unmute();
              rl.output.write(ansiEscapes.cursorShow);
              rl.output.end();
              rl.close();
            };
            this.rl = rl;

            // Make sure new prompt start on a newline when closing
            process.on('exit', this.onForceClose);
            rl.on('SIGINT', this.onForceClose);

            const activePrompt = new prompt(q, rl, this.answers);

            const cleanup = () => {
              onClose();
              this.rl = undefined;
              cleanupSignal?.();
            };

            if (signal) {
              const abort = () => {
                reject(new AbortPromptError({ cause: signal.reason }));
                cleanup();
              };
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener('abort', abort);
              cleanupSignal = () => {
                signal.removeEventListener('abort', abort);
                cleanupSignal = undefined;
              };
            }
            activePrompt.run().then(resolve, reject).finally(cleanup);
          })
      : prompt;

    const { signal: moduleSignal } = this.opt;
    if (moduleSignal?.aborted) {
      this.abortController.abort(moduleSignal.reason);
    } else if (moduleSignal) {
      const abort = (reason: unknown) => this.abortController?.abort(reason);
      moduleSignal.addEventListener('abort', abort);
      cleanupSignal = () => {
        moduleSignal.removeEventListener('abort', abort);
      };
    }

    const { filter = (value) => value } = question;
    const { signal } = this.abortController;
    return promptFn(question, { ...this.opt, signal })
      .then((answer: unknown) => ({
        name: question.name,
        answer: filter(answer, this.answers),
      }))
      .finally(() => {
        cleanupSignal?.();
      });
  };

  /**
   * Handle the ^C exit
   */
  private onForceClose = () => {
    this.close();
    process.kill(process.pid, 'SIGINT');
    console.log('');
  };

  /**
   * Close the interface and cleanup listeners
   */
  close = () => {
    this.abortController?.abort();
  };

  private shouldRun = async (question: AnyQuestion<A>): Promise<boolean> => {
    if (
      question.askAnswered !== true &&
      _.get(this.answers, question.name) !== undefined
    ) {
      return false;
    }

    const { when } = question;
    if (typeof when === 'function') {
      const shouldRun = await runAsync(when)(this.answers);
      return shouldRun !== false;
    }

    return when !== false;
  };
}
