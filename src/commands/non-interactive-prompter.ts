import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * Creates a prompter that logs passive wizard output but rejects interactive prompts.
 */
export function createNonInteractiveLoggingPrompter(
  runtime: RuntimeEnv,
  formatPromptError: (message: string) => string,
): WizardPrompter {
  const unavailable = <T>(message: string): Promise<T> =>
    Promise.reject(new Error(formatPromptError(message)));
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
    // Selection/input prompts cannot be answered in non-interactive mode; reject
    // with the original prompt text so callers can surface the blocked question.
    async select(params) {
      return unavailable(params.message);
    },
    async multiselect(params) {
      return unavailable(params.message);
    },
    async text(params) {
      return unavailable(params.message);
    },
    async confirm(params) {
      return unavailable(params.message);
    },
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
