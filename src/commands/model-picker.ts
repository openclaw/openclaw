import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import { formatTokenK } from "./models/shared.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./openai-codex-model-default.js";
import { promptAndConfigureVllm } from "./vllm-setup.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const VLLM_VALUE = "__vllm__";
const PROVIDER_FILTER_THRESHOLD = 30;

// Models that are internal routing features and should not be shown in selection lists.
// These may be valid as defaults (e.g., set automatically during auth flow) but are not
// directly callable via API and would cause "Unknown model" errors if selected manually.
const HIDDEN_ROUTER_MODELS = new Set(["openrouter/auto"]);

type PromptDefaultModelParams = {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  allowKeep?: boolean;
  includeManual?: boolean;
  includeVllm?: boolean;
  ignoreAllowlist?: boolean;
  preferredProvider?: string;
  agentDir?: string;
  message?: string;
};

type PromptDefaultModelResult = { model?: string; config?: OpenClawConfig };
type PromptModelAllowlistResult = { models?: string[] };

function hasAuthForProvider(
  provider: string,
  cfg: OpenClawConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
) {
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (getCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  return false;
}

function createProviderAuthChecker(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
}): (provider: string) => boolean {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const authCache = new Map<string, boolean>();
  return (provider: string) => {
    const cached = authCache.get(provider);
    if (cached !== undefined) {
      return cached;
    }
    const value = hasAuthForProvider(provider, params.cfg, authStore);
    authCache.set(provider, value);
    return value;
  };
}

function resolveConfiguredModelRaw(cfg: OpenClawConfig): string {
  const raw = cfg.agents?.defaults?.model as { primary?: string } | string | undefined;
  if (typeof raw === "string") {
    return raw.trim();
  }
  return raw?.primary?.trim() ?? "";
}

function resolveConfiguredModelKeys(cfg: OpenClawConfig): string[] {
  const models = cfg.agents?.defaults?.models ?? {};
  return Object.keys(models)
    .map((key) => String(key ?? "").trim())
    .filter((key) => key.length > 0);
}

function normalizeModelKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next;
}

function addModelSelectOption(params: {
  entry: {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
  };
  options: WizardSelectOption[];
  seen: Set<string>;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  hasAuth: (provider: string) => boolean;
}) {
  const key = modelKey(params.entry.provider, params.entry.id);
  if (params.seen.has(key)) {
    return;
  }
  // Skip internal router models that can't be directly called via API.
  if (HIDDEN_ROUTER_MODELS.has(key)) {
    return;
  }
  const hints: string[] = [];
  if (params.entry.name && params.entry.name !== params.entry.id) {
    hints.push(params.entry.name);
  }
  if (params.entry.contextWindow) {
    hints.push(`ctx ${formatTokenK(params.entry.contextWindow)}`);
  }
  if (params.entry.reasoning) {
    hints.push("reasoning");
  }
  const aliases = params.aliasIndex.byKey.get(key);
  if (aliases?.length) {
    hints.push(`alias: ${aliases.join(", ")}`);
  }
  if (!params.hasAuth(params.entry.provider)) {
    hints.push("auth missing");
  }
  params.options.push({
    value: key,
    label: key,
    hint: hints.length > 0 ? hints.join(" · ") : undefined,
  });
  params.seen.add(key);
}

function isAnthropicLegacyModel(entry: { provider: string; id: string }): boolean {
  return (
    entry.provider === "anthropic" &&
    typeof entry.id === "string" &&
    entry.id.toLowerCase().startsWith("claude-3")
  );
}

async function promptManualModel(params: {
  prompter: WizardPrompter;
  allowBlank: boolean;
  initialValue?: string;
}): Promise<PromptDefaultModelResult> {
  const modelInput = await params.prompter.text({
    message: params.allowBlank ? "Default model (blank to keep)" : "Default model",
    initialValue: params.initialValue,
    placeholder: "provider/model",
    validate: params.allowBlank ? undefined : (value) => (value?.trim() ? undefined : "Required"),
  });
  const model = String(modelInput ?? "").trim();
  if (!model) {
    return {};
  }
  return { model };
}

export async function promptDefaultModel(
  params: PromptDefaultModelParams,
): Promise<PromptDefaultModelResult> {
  const cfg = params.config;
  const allowKeep = params.allowKeep ?? true;
  const includeManual = params.includeManual ?? true;
  const includeVllm = params.includeVllm ?? false;
  const ignoreAllowlist = params.ignoreAllowlist ?? false;
  const preferredProviderRaw = params.preferredProvider?.trim();
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const configuredRaw = resolveConfiguredModelRaw(cfg);

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const configuredKey = configuredRaw ? resolvedKey : "";

  const catalog = await loadModelCatalog({ config: cfg, useCache: false });
  if (catalog.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  let models = catalog;
  if (!ignoreAllowlist) {
    const { allowedCatalog } = buildAllowedModelSet({
      cfg,
      catalog,
      defaultProvider: DEFAULT_PROVIDER,
    });
    models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
  }

  if (models.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const providers = Array.from(new Set(models.map((entry) => entry.provider))).toSorted((a, b) =>
    a.localeCompare(b),
  );

  const hasPreferredProvider = preferredProvider ? providers.includes(preferredProvider) : false;
  const shouldPromptProvider =
    !hasPreferredProvider && providers.length > 1 && models.length > PROVIDER_FILTER_THRESHOLD;
  if (shouldPromptProvider) {
    const selection = await params.prompter.select({
      message: "Filter models by provider",
      options: [
        { value: "*", label: "All providers" },
        ...providers.map((provider) => {
          const count = models.filter((entry) => entry.provider === provider).length;
          return {
            value: provider,
            label: provider,
            hint: `${count} model${count === 1 ? "" : "s"}`,
          };
        }),
      ],
    });
    if (selection !== "*") {
      models = models.filter((entry) => entry.provider === selection);
    }
  }

  if (hasPreferredProvider && preferredProvider) {
    models = models.filter((entry) => {
      if (preferredProvider === "volcengine") {
        return entry.provider === "volcengine" || entry.provider === "volcengine-plan";
      }
      if (preferredProvider === "byteplus") {
        return entry.provider === "byteplus" || entry.provider === "byteplus-plan";
      }
      return entry.provider === preferredProvider;
    });
    if (preferredProvider === "anthropic") {
      models = models.filter((entry) => !isAnthropicLegacyModel(entry));
    }
  }

  const agentDir = params.agentDir;
  const hasAuth = createProviderAuthChecker({ cfg, agentDir });

  const options: WizardSelectOption[] = [];
  if (allowKeep) {
    options.push({
      value: KEEP_VALUE,
      label: configuredRaw
        ? `Keep current (${configuredRaw})`
        : `Keep current (default: ${resolvedKey})`,
      hint:
        configuredRaw && configuredRaw !== resolvedKey ? `resolves to ${resolvedKey}` : undefined,
    });
  }
  if (includeManual) {
    options.push({ value: MANUAL_VALUE, label: "Enter model manually" });
  }
  if (includeVllm && agentDir) {
    options.push({
      value: VLLM_VALUE,
      label: "vLLM (custom)",
      hint: "Enter vLLM URL + API key + model",
    });
  }

  const seen = new Set<string>();

  for (const entry of models) {
    addModelSelectOption({ entry, options, seen, aliasIndex, hasAuth });
  }

  if (configuredKey && !seen.has(configuredKey)) {
    options.push({
      value: configuredKey,
      label: configuredKey,
      hint: "current (not in catalog)",
    });
  }

  let initialValue: string | undefined = allowKeep ? KEEP_VALUE : configuredKey || undefined;
  if (
    allowKeep &&
    hasPreferredProvider &&
    preferredProvider &&
    resolved.provider !== preferredProvider
  ) {
    const firstModel = models[0];
    if (firstModel) {
      initialValue = modelKey(firstModel.provider, firstModel.id);
    }
  }

  const selection = await params.prompter.select({
    message: params.message ?? "Default model",
    options,
    initialValue,
  });

  if (selection === KEEP_VALUE) {
    return {};
  }
  if (selection === MANUAL_VALUE) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: false,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }
  if (selection === VLLM_VALUE) {
    if (!agentDir) {
      await params.prompter.note(
        "vLLM setup requires an agent directory context.",
        "vLLM not available",
      );
      return {};
    }
    const { config: nextConfig, modelRef } = await promptAndConfigureVllm({
      cfg,
      prompter: params.prompter,
      agentDir,
    });

    return { model: modelRef, config: nextConfig };
  }
  return { model: String(selection) };
}

export async function promptModelAllowlist(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  message?: string;
  agentDir?: string;
  allowedKeys?: string[];
  initialSelections?: string[];
}): Promise<PromptModelAllowlistResult> {
  const cfg = params.config;
  const existingKeys = resolveConfiguredModelKeys(cfg);
  const allowedKeys = normalizeModelKeys(params.allowedKeys ?? []);
  const allowedKeySet = allowedKeys.length > 0 ? new Set(allowedKeys) : null;
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const initialSeeds = normalizeModelKeys([
    ...existingKeys,
    resolvedKey,
    ...(params.initialSelections ?? []),
  ]);
  const initialKeys = allowedKeySet
    ? initialSeeds.filter((key) => allowedKeySet.has(key))
    : initialSeeds;

  const catalog = await loadModelCatalog({ config: cfg, useCache: false });
  if (catalog.length === 0 && allowedKeys.length === 0) {
    const raw = await params.prompter.text({
      message:
        params.message ??
        "Allowlist models (comma-separated provider/model; blank to keep current)",
      initialValue: existingKeys.join(", "),
      placeholder: `${OPENAI_CODEX_DEFAULT_MODEL}, anthropic/claude-opus-4-6`,
    });
    const parsed = String(raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (parsed.length === 0) {
      return {};
    }
    return { models: normalizeModelKeys(parsed) };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const hasAuth = createProviderAuthChecker({ cfg, agentDir: params.agentDir });

  const options: WizardSelectOption[] = [];
  const seen = new Set<string>();

  const filteredCatalog = allowedKeySet
    ? catalog.filter((entry) => allowedKeySet.has(modelKey(entry.provider, entry.id)))
    : catalog;

  for (const entry of filteredCatalog) {
    addModelSelectOption({ entry, options, seen, aliasIndex, hasAuth });
  }

  const supplementalKeys = allowedKeySet ? allowedKeys : existingKeys;
  for (const key of supplementalKeys) {
    if (seen.has(key)) {
      continue;
    }
    options.push({
      value: key,
      label: key,
      hint: allowedKeySet ? "allowed (not in catalog)" : "configured (not in catalog)",
    });
    seen.add(key);
  }

  if (options.length === 0) {
    return {};
  }

  const selection = await params.prompter.multiselect({
    message: params.message ?? "Models in /model picker (multi-select)",
    options,
    initialValues: initialKeys.length > 0 ? initialKeys : undefined,
    searchable: true,
  });
  const selected = normalizeModelKeys(selection.map((value) => String(value)));
  if (selected.length > 0) {
    return { models: selected };
  }
  if (existingKeys.length === 0) {
    return { models: [] };
  }
  const confirmClear = await params.prompter.confirm({
    message: "Clear the model allowlist? (shows all models)",
    initialValue: false,
  });
  if (!confirmClear) {
    return {};
  }
  return { models: [] };
}

export function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = defaults?.models;
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: model,
        },
        models: {
          ...existingModels,
          [model]: existingModels?.[model] ?? {},
        },
      },
    },
  };
}

export function applyModelAllowlist(cfg: OpenClawConfig, models: string[]): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const normalized = normalizeModelKeys(models);
  if (normalized.length === 0) {
    if (!defaults?.models) {
      return cfg;
    }
    const { models: _ignored, ...restDefaults } = defaults;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: restDefaults,
      },
    };
  }

  const existingModels = defaults?.models ?? {};
  const nextModels: Record<string, { alias?: string }> = {};
  for (const key of normalized) {
    nextModels[key] = existingModels[key] ?? {};
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        models: nextModels,
      },
    },
  };
}

export function applyModelFallbacksFromSelection(
  cfg: OpenClawConfig,
  selection: string[],
): OpenClawConfig {
  const normalized = normalizeModelKeys(selection);
  if (normalized.length <= 1) {
    return cfg;
  }

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  if (!normalized.includes(resolvedKey)) {
    return cfg;
  }

  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? existingModel.primary
        : undefined;

  const fallbacks = normalized.filter((key) => key !== resolvedKey);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(typeof existingModel === "object" ? existingModel : undefined),
          primary: existingPrimary ?? resolvedKey,
          fallbacks,
        },
      },
    },
  };
}
