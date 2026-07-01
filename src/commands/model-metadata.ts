import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { MODEL_APIS } from "../config/types.models.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const DEFAULT_MAX_TOKENS = 8192;

export type ConfiguredModel = {
  provider: string;
  modelIndex: number;
  model: ModelDefinitionConfig;
  modelKey: string;
};

export function collectConfiguredModels(cfg: OpenClawConfig): ConfiguredModel[] {
  const result: ConfiguredModel[] = [];
  const providers = cfg.models?.providers ?? {};
  for (const [provider, providerCfg] of Object.entries(providers)) {
    if (!providerCfg?.models) {
      continue;
    }
    for (let i = 0; i < providerCfg.models.length; i++) {
      const model = providerCfg.models[i];
      if (!model) {
        continue;
      }
      result.push({
        provider,
        modelIndex: i,
        model,
        modelKey: `${provider}/${model.id}`,
      });
    }
  }
  return result;
}

export function applyModelDefinitionUpdate(
  cfg: OpenClawConfig,
  entry: ConfiguredModel,
  updated: ModelDefinitionConfig,
): OpenClawConfig {
  const providers = { ...cfg.models?.providers };
  const providerCfg = providers[entry.provider];
  if (!providerCfg) {
    return cfg;
  }

  const models = [...providerCfg.models];
  models[entry.modelIndex] = updated;
  providers[entry.provider] = { ...providerCfg, models };

  return {
    ...cfg,
    models: { ...cfg.models, providers },
  };
}

export function findModelInConfig(
  cfg: OpenClawConfig,
  provider: string,
  modelId: string,
): ConfiguredModel | undefined {
  const models = collectConfiguredModels(cfg);
  return models.find((m) => m.provider === provider && m.model.id === modelId);
}

/** Find the model entry matching the current primary model key. */
export function findPrimaryModelEntry(cfg: OpenClawConfig): ConfiguredModel | undefined {
  const primaryKey = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  if (!primaryKey) {
    return undefined;
  }
  const parts = primaryKey.split("/");
  const provider = parts[0];
  const modelId = parts.slice(1).join("/");
  return findModelInConfig(cfg, provider, modelId);
}

export function formatTokenCount(n: number | undefined): string {
  if (!n) {
    return "";
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
}

function parsePositiveInt(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseNonNegativeNumber(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function promptModelMetadata(
  prompter: WizardPrompter,
  current?: Partial<ModelDefinitionConfig>,
): Promise<Partial<ModelDefinitionConfig>> {
  const result: Partial<ModelDefinitionConfig> = {};

  const modelId = current?.id ?? "unknown";
  await prompter.note(
    `Editing metadata for model: ${modelId}\nPress Enter to keep defaults.`,
    "Model metadata",
  );

  result.name = await prompter.text({
    message: "Display name",
    initialValue: current?.name ?? modelId,
    placeholder: modelId,
    validate: (v) => (v.trim() ? undefined : "Display name cannot be empty"),
  });

  const apiOptions = [
    { value: "__auto", label: "Auto (inherit from provider)", hint: "default" },
    ...MODEL_APIS.map((api) => ({ value: api, label: api })),
  ];
  const apiChoice = await prompter.select({
    message: "API adapter",
    options: apiOptions,
    initialValue: (current?.api as string) ?? "__auto",
  });
  if (apiChoice !== "__auto") {
    result.api = apiChoice as (typeof MODEL_APIS)[number];
  }

  result.reasoning = await prompter.confirm({
    message: "Supports reasoning/thinking?",
    initialValue: current?.reasoning ?? false,
  });

  const inputOptions = [
    { value: "text", label: "Text" },
    { value: "image", label: "Image" },
  ];
  const inputChoice = await prompter.multiselect({
    message: "Input modalities",
    options: inputOptions,
    initialValues: (current?.input as string[]) ?? ["text"],
  });
  result.input = inputChoice as Array<"text" | "image">;

  const cwRaw = await prompter.text({
    message: "Context window (tokens)",
    initialValue: String(current?.contextWindow ?? DEFAULT_CONTEXT_TOKENS),
    validate: (v) => {
      const n = parsePositiveInt(v);
      if (!n) {
        return "Must be a positive integer";
      }
      if (n < CONTEXT_WINDOW_HARD_MIN_TOKENS) {
        return `Minimum: ${CONTEXT_WINDOW_HARD_MIN_TOKENS}`;
      }
      return undefined;
    },
  });
  result.contextWindow = parsePositiveInt(cwRaw)!;

  const defaultMaxTokens = Math.min(DEFAULT_MAX_TOKENS, result.contextWindow);
  const mtRaw = await prompter.text({
    message: "Max output tokens",
    initialValue: String(current?.maxTokens ?? defaultMaxTokens),
    validate: (v) => {
      const n = parsePositiveInt(v);
      if (!n) {
        return "Must be a positive integer";
      }
      if (n > result.contextWindow!) {
        return `Cannot exceed context window (${result.contextWindow})`;
      }
      return undefined;
    },
  });
  result.maxTokens = parsePositiveInt(mtRaw)!;

  const configureCost = await prompter.confirm({
    message: "Configure token pricing?",
    initialValue: Boolean(current?.cost),
  });

  if (configureCost) {
    const costInput = await prompter.text({
      message: "Input cost (per million tokens)",
      initialValue: String(current?.cost?.input ?? 0),
      validate: (v) => (parseNonNegativeNumber(v) !== undefined ? undefined : "Must be >= 0"),
    });
    const costOutput = await prompter.text({
      message: "Output cost (per million tokens)",
      initialValue: String(current?.cost?.output ?? 0),
      validate: (v) => (parseNonNegativeNumber(v) !== undefined ? undefined : "Must be >= 0"),
    });
    const costCacheRead = await prompter.text({
      message: "Cache read cost (per million tokens)",
      initialValue: String(current?.cost?.cacheRead ?? 0),
      validate: (v) => (parseNonNegativeNumber(v) !== undefined ? undefined : "Must be >= 0"),
    });
    const costCacheWrite = await prompter.text({
      message: "Cache write cost (per million tokens)",
      initialValue: String(current?.cost?.cacheWrite ?? 0),
      validate: (v) => (parseNonNegativeNumber(v) !== undefined ? undefined : "Must be >= 0"),
    });
    result.cost = {
      input: parseNonNegativeNumber(costInput)!,
      output: parseNonNegativeNumber(costOutput)!,
      cacheRead: parseNonNegativeNumber(costCacheRead)!,
      cacheWrite: parseNonNegativeNumber(costCacheWrite)!,
    };
  }

  return result;
}

/**
 * After custom provider setup, offer to configure metadata for the primary model.
 * Custom providers always write explicit model entries to config, so the entry
 * is guaranteed to exist when this is called from the custom-api-key path.
 */
export async function promptModelMetadataForPrimary(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const entry = findPrimaryModelEntry(cfg);
  if (!entry) {
    return cfg;
  }

  const editMeta = await prompter.confirm({
    message: `Configure metadata for ${entry.modelKey}? (context window, max tokens, etc.)`,
    initialValue: true,
  });
  if (!editMeta) {
    return cfg;
  }

  const updated = await promptModelMetadata(prompter, entry.model);
  const merged: ModelDefinitionConfig = {
    ...entry.model,
    ...updated,
    id: entry.model.id,
  } as ModelDefinitionConfig;
  return applyModelDefinitionUpdate(cfg, entry, merged);
}
