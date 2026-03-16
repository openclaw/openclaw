import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import { formatTokenK } from "./models/shared.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
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
  includeProviderPluginSetups?: boolean;
  ignoreAllowlist?: boolean;
  preferredProvider?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: import("../runtime.js").RuntimeEnv;
  message?: string;
};

type PromptDefaultModelResult = { model?: string; config?: OpenClawConfig };
type PromptModelAllowlistResult = { models?: string[] };

async function loadModelPickerRuntime() {
  return import("./model-picker.runtime.js");
}

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
  if (hasUsableCustomProviderApiKey(cfg, provider)) {
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
  return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
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
    hints.push("推理");
  }
  const aliases = params.aliasIndex.byKey.get(key);
  if (aliases?.length) {
    hints.push(`alias: ${aliases.join(", ")}`);
  }
  if (!params.hasAuth(params.entry.provider)) {
    hints.push("未配置认证");
  }
  params.options.push({
    value: key,
    label: key,
    hint: hints.length > 0 ? hints.join(" · ") : undefined,
  });
  params.seen.add(key);
}

async function promptManualModel(params: {
  prompter: WizardPrompter;
  allowBlank: boolean;
  initialValue?: string;
}): Promise<PromptDefaultModelResult> {
  const modelInput = await params.prompter.text({
    message: params.allowBlank ? "默认模型（留空则保留当前值）" : "默认模型",
    initialValue: params.initialValue,
    placeholder: "provider/model",
    validate: params.allowBlank ? undefined : (value) => (value?.trim() ? undefined : "必填"),
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
  const includeProviderPluginSetups = params.includeProviderPluginSetups ?? false;
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

  const providerIds = Array.from(new Set(models.map((entry) => entry.provider))).toSorted((a, b) =>
    a.localeCompare(b),
  );

  const hasPreferredProvider = preferredProvider ? providerIds.includes(preferredProvider) : false;
  const shouldPromptProvider =
    !hasPreferredProvider && providerIds.length > 1 && models.length > PROVIDER_FILTER_THRESHOLD;
  if (shouldPromptProvider) {
    const selection = await params.prompter.select({
      message: "按提供方筛选模型",
      options: [
        { value: "*", label: "全部提供方" },
        ...providerIds.map((provider) => {
          const count = models.filter((entry) => entry.provider === provider).length;
          return {
            value: provider,
            label: provider,
            hint: `${count} 个模型`,
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
  }

  const agentDir = params.agentDir;
  const hasAuth = createProviderAuthChecker({ cfg, agentDir });

  const options: WizardSelectOption[] = [];
  if (allowKeep) {
    options.push({
      value: KEEP_VALUE,
      label: configuredRaw
        ? `保留当前值（${configuredRaw}）`
        : `保留当前值（默认：${resolvedKey}）`,
      hint: configuredRaw && configuredRaw !== resolvedKey ? `解析为 ${resolvedKey}` : undefined,
    });
  }
  if (includeManual) {
    options.push({ value: MANUAL_VALUE, label: "手动输入模型" });
  }
  if (includeProviderPluginSetups && agentDir) {
    const { resolveProviderModelPickerEntries } = await loadModelPickerRuntime();
    options.push(
      ...resolveProviderModelPickerEntries({
        config: cfg,
        workspaceDir: params.workspaceDir,
        env: params.env,
      }),
    );
  }

  const seen = new Set<string>();

  for (const entry of models) {
    addModelSelectOption({ entry, options, seen, aliasIndex, hasAuth });
  }

  if (configuredKey && !seen.has(configuredKey)) {
    options.push({
      value: configuredKey,
      label: configuredKey,
      hint: "当前值（目录中不存在）",
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
    message: params.message ?? "默认模型",
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

  let pluginResolution: string | null = null;
  let pluginProviders: ProviderPlugin[] = [];
  if (selection.startsWith("provider-plugin:")) {
    pluginResolution = selection;
  } else if (!selection.includes("/")) {
    const { resolvePluginProviders } = await loadModelPickerRuntime();
    pluginProviders = resolvePluginProviders({
      config: cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
    pluginResolution = pluginProviders.some(
      (provider) => normalizeProviderId(provider.id) === normalizeProviderId(selection),
    )
      ? selection
      : null;
  }
  if (pluginResolution) {
    if (!agentDir || !params.runtime) {
      await params.prompter.note("提供方设置需要智能体和运行时上下文。", "提供方设置不可用");
      return {};
    }
    const {
      resolvePluginProviders,
      resolveProviderPluginChoice,
      runProviderModelSelectedHook,
      runProviderPluginAuthMethod,
    } = await loadModelPickerRuntime();
    if (pluginProviders.length === 0) {
      pluginProviders = resolvePluginProviders({
        config: cfg,
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
    }
    const resolved = resolveProviderPluginChoice({
      providers: pluginProviders,
      choice: pluginResolution,
    });
    if (!resolved) {
      return {};
    }
    const applied = await runProviderPluginAuthMethod({
      config: cfg,
      runtime: params.runtime,
      prompter: params.prompter,
      method: resolved.method,
      agentDir,
      workspaceDir: params.workspaceDir,
    });
    if (applied.defaultModel) {
      await runProviderModelSelectedHook({
        config: applied.config,
        model: applied.defaultModel,
        prompter: params.prompter,
        agentDir,
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
    }
    return { model: applied.defaultModel, config: applied.config };
  }
  const model = String(selection);
  const { runProviderModelSelectedHook } = await loadModelPickerRuntime();
  await runProviderModelSelectedHook({
    config: cfg,
    model,
    prompter: params.prompter,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return { model };
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
      message: params.message ?? "模型白名单（用逗号分隔 provider/model；留空则保留当前值）",
      initialValue: existingKeys.join(", "),
      placeholder: "provider/model, other-provider/model",
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
      hint: allowedKeySet ? "已允许（目录中不存在）" : "已配置（目录中不存在）",
    });
    seen.add(key);
  }

  if (options.length === 0) {
    return {};
  }

  const selection = await params.prompter.multiselect({
    message: params.message ?? "在 /model 选择器中显示的模型（可多选）",
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
    message: "清空模型白名单？（将显示全部模型）",
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
