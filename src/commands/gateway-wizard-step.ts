import type { WizardStep } from "../../packages/gateway-protocol/src/schema/wizard.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Project a Gateway wizard's input contract onto a terminal prompter. */
export async function answerGatewayWizardStep(
  step: WizardStep,
  prompter: WizardPrompter,
  options: { signal?: AbortSignal; searchable?: boolean } = {},
): Promise<unknown> {
  const message = step.message ?? step.title ?? "Continue";
  switch (step.type) {
    case "text": {
      const value = await prompter.text({
        message,
        sensitive: step.sensitive,
        placeholder: step.placeholder,
        initialValue: typeof step.initialValue === "string" ? step.initialValue : undefined,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (step.sensitive) {
        registerSecretValueForRedaction(value);
      }
      return value;
    }
    case "select":
      return await prompter.select({
        message,
        options: step.options ?? [],
        initialValue: step.initialValue,
        ...(options.searchable ? { searchable: true } : {}),
      });
    case "multiselect":
      return await prompter.multiselect({
        message,
        options: step.options ?? [],
        initialValues: Array.isArray(step.initialValue) ? step.initialValue : undefined,
        ...(options.searchable ? { searchable: true } : {}),
      });
    case "confirm":
    case "action":
      return await prompter.confirm({
        message,
        initialValue: typeof step.initialValue === "boolean" ? step.initialValue : undefined,
      });
    case "note":
      await prompter.note(message, step.title);
      break;
    case "progress":
      break;
  }
  return undefined;
}
