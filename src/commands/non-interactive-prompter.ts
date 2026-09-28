/** Non-interactive wizard prompter that logs progress but rejects input prompts. */
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Builds a WizardPrompter for commands that must fail instead of prompting. */
export function createNonInteractiveLoggingPrompter(
  runtime: RuntimeEnv,
  formatPromptError: (message: string) => string,
): WizardPrompter {
  const unavailable = async <T>(params: { message: string }): Promise<T> => {
    throw new Error(formatPromptError(params.message));
  };
  return {
    async intro(title) {
      runtime.log(title);
    },
    async outro(message) {
      runtime.log(message);
    },
    async note(message, title) {
      runtime.log(title ? `${title}\n${message}` : message);
    },
    select: unavailable,
    multiselect: unavailable,
    text: unavailable,
    confirm: unavailable,
    progress(label) {
      runtime.log(label);
      return {
        update(message) {
          runtime.log(message);
        },
        stop(message) {
          if (message) {
            runtime.log(message);
          }
        },
      };
    },
  };
}
