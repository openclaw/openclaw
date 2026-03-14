import { GUARD_MODEL_CATALOG } from "../agents/guard-model-registry.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";

type PromptGuardModelParams = {
  prompter: WizardPrompter;
  existingPrimary?: string;
  message?: string;
};

export async function promptGuardModel(
  params: PromptGuardModelParams,
): Promise<{ model?: string }> {
  const { prompter, existingPrimary, message } = params;

  type SelectOption = { value: string; label: string; hint?: string };
  const options: SelectOption[] = [];

  if (existingPrimary) {
    options.push({
      value: KEEP_VALUE,
      label: `Keep current (${existingPrimary})`,
      hint: GUARD_MODEL_CATALOG.some((e) => e.value === existingPrimary)
        ? undefined
        : "not in curated list",
    });
  }

  for (const entry of GUARD_MODEL_CATALOG) {
    options.push({ value: entry.value, label: entry.label, hint: entry.hint });
  }

  // Surface the existing model even if it's not in the curated list.
  if (existingPrimary && !GUARD_MODEL_CATALOG.some((e) => e.value === existingPrimary)) {
    options.push({
      value: existingPrimary,
      label: existingPrimary,
      hint: "current · not in curated list",
    });
  }

  options.push({ value: MANUAL_VALUE, label: "Enter model manually" });

  const selection = await prompter.select({
    message: message ?? "Guard model",
    options,
    initialValue: existingPrimary ? KEEP_VALUE : GUARD_MODEL_CATALOG[0]?.value,
  });

  if (selection === KEEP_VALUE) {
    return {};
  }

  if (selection === MANUAL_VALUE) {
    const input = await prompter.text({
      message: "Guard model (provider/model format)",
      placeholder: "chutes/Qwen/Qwen3Guard",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const model = String(input ?? "").trim();
    return model ? { model } : {};
  }

  return { model: String(selection) };
}
