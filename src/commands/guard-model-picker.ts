import type { WizardPrompter } from "../wizard/prompts.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";

type GuardModelEntry = {
  value: string;
  label: string;
  hint: string;
};

// Curated list of known OpenAI-compatible safety/guard classification models.
// These are purpose-built classifiers that respond with SAFE/UNSAFE verdicts.
// Must be accessible via an OpenAI chat-completions or responses API endpoint.
export const GUARD_MODEL_CATALOG: GuardModelEntry[] = [
  {
    value: "chutes/Qwen/Qwen3Guard",
    label: "chutes/Qwen/Qwen3Guard",
    hint: "Qwen3Guard · Alibaba/Qwen · purpose-built safety classifier",
  },
  {
    value: "groq/meta-llama/llama-guard-3-8b",
    label: "groq/meta-llama/llama-guard-3-8b",
    hint: "Llama Guard 3 8B · Meta · fast inference via Groq",
  },
  {
    value: "together/meta-llama/Llama-Guard-3-8B",
    label: "together/meta-llama/Llama-Guard-3-8B",
    hint: "Llama Guard 3 8B · Meta · via Together AI",
  },
  {
    value: "together/meta-llama/Meta-Llama-Guard-2-8B",
    label: "together/meta-llama/Meta-Llama-Guard-2-8B",
    hint: "Llama Guard 2 8B · Meta · via Together AI",
  },
  {
    value: "openrouter/meta-llama/llama-guard-3-8b",
    label: "openrouter/meta-llama/llama-guard-3-8b",
    hint: "Llama Guard 3 8B · Meta · via OpenRouter",
  },
];

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
