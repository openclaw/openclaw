import { isBuiltinWebSearchProviderId } from "../agents/tools/web-search-provider-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import {
  applyCapabilitySlotSelection,
  resolveCapabilitySlotSelection,
} from "../plugins/capability-slots.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type {
  PluginConfigUiHint,
  PluginOrigin,
  SearchProviderLegacyConfigMetadata,
} from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";
import {
  ensureGenericOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
} from "./onboarding/plugin-install.js";
import {
  buildProviderSelectionOptions,
  type ProviderManagementIntent,
} from "./provider-management.js";
import {
  SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG,
  type InstallableSearchProviderPluginCatalogEntry,
} from "./search-provider-plugin-catalog.js";

export type SearchProvider = string;

const SEARCH_PROVIDER_INSTALL_SENTINEL = "__install_plugin__" as const;
const SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL = "__keep_current__" as const;
const SEARCH_PROVIDER_SKIP_SENTINEL = "__skip__" as const;

type PluginSearchProviderEntry = {
  kind: "plugin";
  value: string;
  label: string;
  hint: string;
  configured: boolean;
  pluginId: string;
  origin: PluginOrigin;
  description: string | undefined;
  docsUrl: string | undefined;
  configFieldOrder?: string[];
  configJsonSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  legacyConfig?: SearchProviderLegacyConfigMetadata;
};

export type SearchProviderPickerEntry = PluginSearchProviderEntry;

type SearchProviderPickerChoice = string;
type SearchProviderFlowIntent = ProviderManagementIntent;

type PluginPromptableField =
  | {
      key: string;
      label: string;
      kind: "string";
      placeholder?: string;
      help?: string;
      sensitive?: boolean;
      existingValue?: string;
    }
  | {
      key: string;
      label: string;
      kind: "enum";
      options: string[];
      help?: string;
      existingValue?: string;
    }
  | {
      key: string;
      label: string;
      kind: "boolean";
      help?: string;
      existingValue?: boolean;
    };

type SearchProviderHookDetails = {
  providerId: string;
  providerLabel: string;
  providerSource: "builtin" | "plugin";
  pluginId?: string;
  configured: boolean;
};

const HOOK_RUNNER_LOGGER = {
  warn: () => {},
  error: () => {},
} as const;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function humanizeConfigKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatPluginSourceHint(origin: PluginOrigin): string {
  return origin === "bundled" ? "Bundled plugin" : "External plugin";
}

export function resolveInstallableSearchProviderPlugins(
  providerEntries: SearchProviderPickerEntry[],
): InstallableSearchProviderPluginCatalogEntry[] {
  const loadedPluginProviderIds = new Set(
    providerEntries.filter((entry) => entry.kind === "plugin").map((entry) => entry.value),
  );
  return SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG.filter((entry) => {
    const providerEntry = providerEntries.find(
      (providerEntry) =>
        providerEntry.kind === "plugin" && providerEntry.value === entry.providerId,
    );
    return providerEntry?.kind !== "plugin" || providerEntry.origin !== "bundled";
  }).map((entry) => ({
    ...entry,
    description: loadedPluginProviderIds.has(entry.providerId)
      ? `${entry.description} Already installed.`
      : entry.description,
  }));
}

function normalizePluginConfigObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
    : {};
}

function getPluginConfig(config: OpenClawConfig, pluginId: string): Record<string, unknown> {
  return normalizePluginConfigObject(config.plugins?.entries?.[pluginId]?.config);
}

function setPluginConfig(
  config: OpenClawConfig,
  pluginId: string,
  pluginConfig: Record<string, unknown>,
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId]: {
          ...(config.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
          config: pluginConfig,
        },
      },
    },
  };
}

function setWebSearchProvider(config: OpenClawConfig, provider: string): OpenClawConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider,
          enabled: true,
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePromptablePluginFields(
  entry: PluginSearchProviderEntry,
  pluginConfig: Record<string, unknown>,
): PluginPromptableField[] {
  const jsonSchema = entry.configJsonSchema;
  if (!isRecord(jsonSchema)) {
    return [];
  }
  const properties = jsonSchema.properties;
  if (!isRecord(properties)) {
    return [];
  }

  const keys =
    entry.configFieldOrder?.filter((key) => key in properties) ?? Object.keys(properties);

  const fields: PluginPromptableField[] = [];
  for (const key of keys) {
    const propertySchema = properties[key];
    if (!isRecord(propertySchema)) {
      continue;
    }
    const uiHint = entry.configUiHints?.[key];
    if (uiHint?.advanced) {
      continue;
    }
    const label = uiHint?.label?.trim() || humanizeConfigKey(key);
    const help = uiHint?.help?.trim() || undefined;
    const existingValue = pluginConfig[key];

    const enumValues = Array.isArray(propertySchema.enum)
      ? propertySchema.enum.filter((value): value is string => typeof value === "string")
      : [];
    if (enumValues.length > 0) {
      fields.push({
        key,
        label,
        kind: "enum",
        options: enumValues,
        help,
        existingValue: hasNonEmptyString(existingValue) ? existingValue : undefined,
      });
      continue;
    }

    if (propertySchema.type === "boolean") {
      fields.push({
        key,
        label,
        kind: "boolean",
        help,
        existingValue: typeof existingValue === "boolean" ? existingValue : undefined,
      });
      continue;
    }

    if (propertySchema.type === "string") {
      fields.push({
        key,
        label,
        kind: "string",
        help,
        placeholder: uiHint?.placeholder,
        sensitive: uiHint?.sensitive,
        existingValue: hasNonEmptyString(existingValue) ? existingValue : undefined,
      });
    }
  }

  return fields;
}

function validatePluginSearchProviderConfig(
  entry: PluginSearchProviderEntry,
  pluginConfig: Record<string, unknown>,
): { ok: true } | { ok: false; fieldKey?: string; message: string } {
  if (!entry.configJsonSchema) {
    return { ok: true };
  }

  const result = validateJsonSchemaValue({
    schema: entry.configJsonSchema,
    cacheKey: `search-provider:${entry.pluginId}`,
    value: pluginConfig,
  });
  if (result.ok) {
    return { ok: true };
  }

  const promptableKeys = new Set(
    resolvePromptablePluginFields(entry, pluginConfig).map((field) => field.key),
  );
  const fieldError = result.errors.find((error) => {
    const fieldKey = error.path.split(".")[0];
    return fieldKey && promptableKeys.has(fieldKey);
  });
  if (fieldError) {
    return {
      ok: false,
      fieldKey: fieldError.path.split(".")[0],
      message: fieldError.message,
    };
  }

  return {
    ok: false,
    message: result.errors[0]?.message ?? "invalid config",
  };
}

function createSearchProviderHookRunner(
  config: OpenClawConfig,
  workspaceDir?: string,
): HookRunner | null {
  try {
    const registry = loadOpenClawPlugins({
      config,
      cache: false,
      workspaceDir,
      suppressOpenAllowlistWarning: true,
    });
    if (registry.typedHooks.length === 0) {
      return null;
    }
    return createHookRunner(registry, {
      logger: HOOK_RUNNER_LOGGER,
      catchErrors: true,
    });
  } catch {
    return null;
  }
}

async function maybeNoteBeforeSearchProviderConfigure(params: {
  hookRunner: HookRunner | null;
  config: OpenClawConfig;
  provider: SearchProviderHookDetails;
  intent: SearchProviderFlowIntent;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<void> {
  if (!params.hookRunner?.hasProviderConfigureHooks("search")) {
    return;
  }
  const activeProviderId =
    resolveCapabilitySlotSelection(params.config, "providers.search") ?? null;
  const ctx = { workspaceDir: params.workspaceDir };
  const result = await params.hookRunner.runBeforeProviderConfigure(
    {
      providerKind: "search",
      slot: "providers.search",
      providerId: params.provider.providerId,
      providerLabel: params.provider.providerLabel,
      providerSource: params.provider.providerSource,
      pluginId: params.provider.pluginId,
      intent: params.intent,
      activeProviderId,
      configured: params.provider.configured,
    },
    ctx,
  );
  const note = result?.note;
  if (note.trim()) {
    await params.prompter.note(note, "Provider setup");
  }
}

async function runAfterSearchProviderHooks(params: {
  hookRunner: HookRunner | null;
  originalConfig: OpenClawConfig;
  resultConfig: OpenClawConfig;
  provider: SearchProviderHookDetails;
  intent: SearchProviderFlowIntent;
  workspaceDir?: string;
}): Promise<void> {
  if (!params.hookRunner) {
    return;
  }
  const activeProviderBefore =
    resolveCapabilitySlotSelection(params.originalConfig, "providers.search") ?? null;
  const activeProviderAfter =
    resolveCapabilitySlotSelection(params.resultConfig, "providers.search") ?? null;

  const ctx = { workspaceDir: params.workspaceDir };
  const genericConfigureEvent = {
    providerKind: "search" as const,
    slot: "providers.search",
    providerId: params.provider.providerId,
    providerLabel: params.provider.providerLabel,
    providerSource: params.provider.providerSource,
    pluginId: params.provider.pluginId,
    intent: params.intent,
    activeProviderId: activeProviderAfter,
    configured: params.provider.configured,
  };

  if (params.hookRunner.hasProviderConfigureHooks("search")) {
    await params.hookRunner.runAfterProviderConfigure(genericConfigureEvent, ctx);
  }

  if (
    activeProviderAfter === params.provider.providerId &&
    activeProviderBefore !== activeProviderAfter &&
    params.hookRunner.hasProviderActivationHooks("search")
  ) {
    const genericActivateEvent = {
      providerKind: "search" as const,
      slot: "providers.search",
      providerId: params.provider.providerId,
      providerLabel: params.provider.providerLabel,
      providerSource: params.provider.providerSource,
      pluginId: params.provider.pluginId,
      previousProviderId: activeProviderBefore,
      intent: params.intent,
    };
    await params.hookRunner.runAfterProviderActivate(genericActivateEvent, ctx);
  }
}

async function promptPluginSearchProviderConfig(
  config: OpenClawConfig,
  entry: PluginSearchProviderEntry,
  prompter: WizardPrompter,
): Promise<{ config: OpenClawConfig; valid: boolean }> {
  let nextConfig = config;
  let nextPluginConfig = getPluginConfig(nextConfig, entry.pluginId);
  const fields = resolvePromptablePluginFields(entry, nextPluginConfig);
  if (fields.length === 0) {
    const validation = validatePluginSearchProviderConfig(entry, nextPluginConfig);
    if (!validation.ok) {
      await prompter.note(
        validation.fieldKey
          ? `${humanizeConfigKey(validation.fieldKey)}: ${validation.message}`
          : [
              "This provider needs configuration that this prompt cannot collect yet.",
              validation.message,
            ].join("\n"),
        "Invalid plugin config",
      );
      return { config, valid: false };
    }
    return { config, valid: true };
  }

  let fieldIndex = 0;
  while (fieldIndex < fields.length) {
    const field = resolvePromptablePluginFields(entry, nextPluginConfig)[fieldIndex];
    if (!field) {
      break;
    }

    if (field.kind === "enum") {
      const value = await prompter.select<string>({
        message: field.help ? `${field.label} (${field.help})` : field.label,
        options: field.options.map((option) => ({
          value: option,
          label: humanizeConfigKey(option),
        })),
        initialValue: field.existingValue ?? field.options[0],
      });
      nextPluginConfig[field.key] = value;
    } else if (field.kind === "boolean") {
      const value = await prompter.confirm({
        message: field.help ? `${field.label} (${field.help})` : field.label,
        initialValue: field.existingValue ?? false,
      });
      nextPluginConfig[field.key] = value;
    } else {
      const value = (
        await prompter.text({
          message: field.help ? `${field.label} (${field.help})` : field.label,
          initialValue: field.sensitive || !field.existingValue ? undefined : field.existingValue,
          placeholder:
            field.existingValue && field.sensitive
              ? "Leave blank to keep current"
              : field.placeholder,
        })
      )?.trim();

      if (value) {
        nextPluginConfig[field.key] = value;
      } else if (field.existingValue) {
        nextPluginConfig[field.key] = field.existingValue;
      } else {
        delete nextPluginConfig[field.key];
      }
    }

    fieldIndex += 1;

    if (fieldIndex >= fields.length) {
      const validation = validatePluginSearchProviderConfig(entry, nextPluginConfig);
      if (!validation.ok) {
        await prompter.note(
          validation.fieldKey
            ? `${humanizeConfigKey(validation.fieldKey)}: ${validation.message}`
            : validation.message,
          "Invalid plugin config",
        );
        if (validation.fieldKey) {
          const nextFieldIndex = fields.findIndex(
            (candidate) => candidate.key === validation.fieldKey,
          );
          fieldIndex = nextFieldIndex >= 0 ? nextFieldIndex : 0;
        } else {
          fieldIndex = 0;
        }
      }
    }
  }

  nextConfig = setPluginConfig(nextConfig, entry.pluginId, nextPluginConfig);
  return { config: nextConfig, valid: true };
}

export async function resolveSearchProviderPickerEntries(
  config: OpenClawConfig,
  workspaceDir?: string,
): Promise<SearchProviderPickerEntry[]> {
  let pluginEntries: PluginSearchProviderEntry[] = [];
  try {
    const registry = loadOpenClawPlugins({
      config,
      cache: false,
      workspaceDir,
      suppressOpenAllowlistWarning: true,
    });
    const resolvedPluginEntries = registry.searchProviders
      .map((registration) => {
        const pluginRecord = registry.plugins.find((plugin) => plugin.id === registration.pluginId);
        if (!pluginRecord) {
          return undefined;
        }
        let configured = false;
        try {
          configured = Boolean(registration.provider.isAvailable?.(config));
        } catch {
          configured = false;
        }

        const sourceHint = formatPluginSourceHint(pluginRecord.origin);
        const baseHint =
          registration.provider.legacyConfig?.hint?.trim() ||
          registration.provider.description?.trim() ||
          pluginRecord.description?.trim() ||
          "Plugin-provided web search";
        const hint = configured
          ? `${baseHint} · ${sourceHint} · configured`
          : `${baseHint} · ${sourceHint}`;

        return {
          kind: "plugin" as const,
          value: registration.provider.id,
          label: registration.provider.name || registration.provider.id,
          hint,
          configured,
          pluginId: registration.pluginId,
          origin: pluginRecord.origin,
          description: registration.provider.description,
          docsUrl: registration.provider.docsUrl,
          configFieldOrder: registration.provider.configFieldOrder,
          configJsonSchema: pluginRecord.configJsonSchema,
          configUiHints: pluginRecord.configUiHints,
          legacyConfig: registration.provider.legacyConfig,
        };
      })
      .filter(Boolean)
      .filter(Boolean) as PluginSearchProviderEntry[];
    pluginEntries = resolvedPluginEntries.toSorted((left, right) =>
      left.label.localeCompare(right.label),
    );
  } catch {
    pluginEntries = [];
  }

  try {
    loadPluginManifestRegistry({
      config,
      workspaceDir,
      cache: false,
    });
    const loadedPluginProviderIds = new Set(pluginEntries.map((entry) => entry.value));
    const bundledManifestEntries = SEARCH_PROVIDER_PLUGIN_INSTALL_CATALOG.map((installEntry) =>
      buildPluginSearchProviderEntryFromManifest({
        config,
        installEntry,
        workspaceDir,
      }),
    )
      .filter(
        (entry): entry is PluginSearchProviderEntry =>
          Boolean(entry) && entry.origin === "bundled" && !loadedPluginProviderIds.has(entry.value),
      )
      .map((entry) => {
        const pluginConfig = getPluginConfig(config, entry.pluginId);
        const validation = validatePluginSearchProviderConfig(entry, pluginConfig);
        return {
          ...entry,
          configured: validation.ok,
        };
      });
    pluginEntries = [...pluginEntries, ...bundledManifestEntries].toSorted((left, right) =>
      left.label.localeCompare(right.label),
    );
  } catch {
    // Ignore manifest lookup failures and fall back to loaded entries only.
  }

  return pluginEntries;
}

export async function resolveSearchProviderPickerEntry(
  config: OpenClawConfig,
  providerId: string,
  workspaceDir?: string,
): Promise<SearchProviderPickerEntry | undefined> {
  const entries = await resolveSearchProviderPickerEntries(config, workspaceDir);
  return entries.find((entry) => entry.value === providerId);
}

function searchProviderIdFromProvides(provides: string[]): string | undefined {
  return provides
    .find((capability) => capability.startsWith("providers.search."))
    ?.slice("providers.search.".length);
}

function buildPluginSearchProviderEntryFromManifestRecord(pluginRecord: {
  id: string;
  name?: string;
  description?: string;
  origin: PluginOrigin;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  provides: string[];
}): PluginSearchProviderEntry | undefined {
  const providerId = searchProviderIdFromProvides(pluginRecord.provides);
  if (!providerId) {
    return undefined;
  }

  const hintParts = [
    pluginRecord.description || "Plugin-provided web search",
    formatPluginSourceHint(pluginRecord.origin),
  ];

  return {
    kind: "plugin",
    value: providerId,
    label: pluginRecord.name || providerId,
    hint: hintParts.join(" · "),
    configured: false,
    pluginId: pluginRecord.id,
    origin: pluginRecord.origin,
    description: pluginRecord.description,
    docsUrl: undefined,
    configFieldOrder: undefined,
    configJsonSchema: pluginRecord.configSchema,
    configUiHints: pluginRecord.configUiHints,
    legacyConfig: undefined,
  };
}

function buildPluginSearchProviderEntryFromManifest(params: {
  config: OpenClawConfig;
  installEntry: InstallableSearchProviderPluginCatalogEntry;
  workspaceDir?: string;
}): PluginSearchProviderEntry | undefined {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: false,
  });
  const pluginRecord = registry.plugins.find((plugin) => plugin.id === params.installEntry.id);
  if (!pluginRecord) {
    return undefined;
  }
  return buildPluginSearchProviderEntryFromManifestRecord(pluginRecord);
}

async function installSearchProviderPlugin(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  workspaceDir?: string;
}): Promise<{ config: OpenClawConfig; installed: boolean; pluginId?: string }> {
  const result = await ensureGenericOnboardingPluginInstalled({
    cfg: params.config,
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
  });
  if (!result.installed) {
    return { config: params.config, installed: false };
  }
  reloadOnboardingPluginRegistry({
    cfg: result.cfg,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    suppressOpenAllowlistWarning: true,
  });
  return { config: result.cfg, installed: true, pluginId: result.pluginId };
}

async function resolveInstalledSearchProviderEntry(params: {
  config: OpenClawConfig;
  pluginId?: string;
  workspaceDir?: string;
}): Promise<PluginSearchProviderEntry | undefined> {
  const providerEntries = await resolveSearchProviderPickerEntries(
    params.config,
    params.workspaceDir,
  );
  if (params.pluginId) {
    const loadedProvider = providerEntries.find(
      (entry) => entry.kind === "plugin" && entry.pluginId === params.pluginId,
    );
    if (loadedProvider?.kind === "plugin") {
      return loadedProvider;
    }
  }
  if (!params.pluginId) {
    return undefined;
  }
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: false,
  });
  const manifestRecord = manifestRegistry.plugins.find((plugin) => plugin.id === params.pluginId);
  if (!manifestRecord) {
    return undefined;
  }
  return buildPluginSearchProviderEntryFromManifestRecord(manifestRecord);
}

export async function applySearchProviderChoice(params: {
  config: OpenClawConfig;
  choice: SearchProviderPickerChoice;
  intent?: SearchProviderFlowIntent;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  opts?: SetupSearchOptions;
}): Promise<OpenClawConfig> {
  const intent = params.intent ?? "switch-active";
  if (
    params.choice === SEARCH_PROVIDER_SKIP_SENTINEL ||
    params.choice === SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL
  ) {
    return params.config;
  }

  if (params.choice === SEARCH_PROVIDER_INSTALL_SENTINEL) {
    const installedConfig = await installSearchProviderPlugin({
      config: params.config,
      runtime: params.runtime,
      prompter: params.prompter,
      workspaceDir: params.opts?.workspaceDir,
    });
    if (!installedConfig.installed) {
      return params.config;
    }
    const installedProvider = await resolveInstalledSearchProviderEntry({
      config: installedConfig.config,
      pluginId: installedConfig.pluginId,
      workspaceDir: params.opts?.workspaceDir,
    });
    if (!installedProvider) {
      await params.prompter.note(
        [
          "Installed plugin, but it did not register a web search provider yet.",
          "Restart the gateway and try configure again if this plugin should provide web search.",
        ].join("\n"),
        "Plugin install",
      );
      return installedConfig.config;
    }
    const enabled = enablePluginInConfig(installedConfig.config, installedProvider.pluginId);
    const hookRunner = createSearchProviderHookRunner(enabled.config, params.opts?.workspaceDir);
    const providerDetails: SearchProviderHookDetails = {
      providerId: installedProvider.value,
      providerLabel: installedProvider.label,
      providerSource: "plugin",
      pluginId: installedProvider.pluginId,
      configured: installedProvider.configured,
    };
    let next =
      intent === "switch-active"
        ? setWebSearchProvider(enabled.config, installedProvider.value)
        : enabled.config;
    await maybeNoteBeforeSearchProviderConfigure({
      hookRunner,
      config: next,
      provider: providerDetails,
      intent,
      prompter: params.prompter,
      workspaceDir: params.opts?.workspaceDir,
    });
    const pluginConfigResult = await promptPluginSearchProviderConfig(
      next,
      installedProvider,
      params.prompter,
    );
    const result = pluginConfigResult.valid
      ? preserveSearchProviderIntent(
          installedConfig.config,
          pluginConfigResult.config,
          intent,
          installedProvider.value,
        )
      : preserveSearchProviderIntent(
          installedConfig.config,
          enabled.config,
          "configure-provider",
          installedProvider.value,
        );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: installedConfig.config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: params.opts?.workspaceDir,
    });
    return result;
  }

  return configureSearchProviderSelection(
    params.config,
    params.choice,
    params.prompter,
    intent,
    params.opts,
  );
}

type SearchProviderPickerModelParams = {
  config: OpenClawConfig;
  providerEntries: SearchProviderPickerEntry[];
  includeSkipOption: boolean;
  skipHint?: string;
};

type SearchProviderPickerModel = {
  unloadedExistingPluginProvider?: string;
  installableEntries: InstallableSearchProviderPluginCatalogEntry[];
  options: Array<{ value: SearchProviderPickerChoice; label: string; hint?: string }>;
  initialValue: SearchProviderPickerChoice;
  configuredCount: number;
  activeProvider?: string;
};

function formatPickerEntryHint(params: {
  entry: SearchProviderPickerEntry;
  isActive: boolean;
  configuredCount: number;
}): string {
  const { entry, isActive, configuredCount } = params;
  const baseParts =
    entry.kind === "plugin"
      ? [
          entry.description?.trim() || "Plugin-provided web search",
          formatPluginSourceHint(entry.origin),
        ]
      : [entry.hint, "Built-in"];

  if (configuredCount > 1) {
    if (entry.configured) {
      baseParts.push(isActive ? "Active now" : "Configured");
    }
  }

  return baseParts.join(" · ");
}

export function buildSearchProviderPickerModel(
  params: SearchProviderPickerModelParams,
): SearchProviderPickerModel {
  const { config, providerEntries, includeSkipOption, skipHint } = params;
  const existingProvider = resolveCapabilitySlotSelection(config, "providers.search");
  const existingPluginProvider =
    typeof existingProvider === "string" &&
    existingProvider.trim() &&
    !isBuiltinWebSearchProviderId(existingProvider)
      ? existingProvider
      : undefined;
  const loadedExistingPluginProvider =
    existingPluginProvider &&
    providerEntries.some(
      (entry) => entry.kind === "plugin" && entry.value === existingPluginProvider,
    )
      ? existingPluginProvider
      : undefined;
  const unloadedExistingPluginProvider =
    existingPluginProvider && !loadedExistingPluginProvider ? existingPluginProvider : undefined;

  const activeLoadedProvider = providerEntries.find(
    (entry) => entry.value === existingProvider,
  )?.value;
  const configuredEntries = providerEntries.filter((entry) => entry.configured);
  const configuredCount = configuredEntries.length;

  const sortedEntries = [...providerEntries].toSorted((left, right) => {
    const leftActive = left.value === activeLoadedProvider;
    const rightActive = right.value === activeLoadedProvider;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }
    return 0;
  });

  const defaultProvider =
    activeLoadedProvider ??
    (configuredCount === 1 ? configuredEntries[0]?.value : undefined) ??
    configuredEntries[0]?.value ??
    sortedEntries[0]?.value ??
    SEARCH_PROVIDER_SKIP_SENTINEL;

  const installableEntries = resolveInstallableSearchProviderPlugins(providerEntries);
  const options: Array<{ value: SearchProviderPickerChoice; label: string; hint?: string }> = [
    ...(unloadedExistingPluginProvider
      ? [
          {
            value: SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL as const,
            label: `Keep current provider (${unloadedExistingPluginProvider})`,
            hint: "Leave the current plugin-managed web_search provider unchanged",
          },
        ]
      : []),
    ...sortedEntries.map((entry) => ({
      value: entry.value,
      label: entry.label,
      hint: formatPickerEntryHint({
        entry,
        isActive: entry.value === activeLoadedProvider,
        configuredCount,
      }),
    })),
    {
      value: SEARCH_PROVIDER_INSTALL_SENTINEL as const,
      label: "Install external provider plugin",
      hint:
        installableEntries.length > 0
          ? "Add an external web search plugin"
          : "Install an external web search plugin from npm or a local path",
    },
    ...(includeSkipOption
      ? [
          {
            value: SEARCH_PROVIDER_SKIP_SENTINEL as const,
            label: "Skip for now",
            hint: skipHint,
          },
        ]
      : []),
  ];

  return {
    unloadedExistingPluginProvider,
    installableEntries,
    options,
    initialValue: unloadedExistingPluginProvider
      ? SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL
      : defaultProvider,
    configuredCount,
    activeProvider: activeLoadedProvider,
  };
}

export async function configureSearchProviderSelection(
  config: OpenClawConfig,
  choice: string,
  prompter: WizardPrompter,
  intent: SearchProviderFlowIntent = "switch-active",
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  const providerEntries = await resolveSearchProviderPickerEntries(config, opts?.workspaceDir);
  const selectedEntry = providerEntries.find((entry) => entry.value === choice);
  if (selectedEntry?.kind === "plugin") {
    const enabled = enablePluginInConfig(config, selectedEntry.pluginId);
    const hookRunner = createSearchProviderHookRunner(enabled.config, opts?.workspaceDir);
    const providerDetails: SearchProviderHookDetails = {
      providerId: selectedEntry.value,
      providerLabel: selectedEntry.label,
      providerSource: "plugin",
      pluginId: selectedEntry.pluginId,
      configured: selectedEntry.configured,
    };
    let next =
      intent === "switch-active"
        ? setWebSearchProvider(enabled.config, selectedEntry.value)
        : enabled.config;
    const legacyConfig = selectedEntry.legacyConfig;
    const existingKey = legacyConfig ? resolveExistingKey(config, legacyConfig) : undefined;
    const keyConfigured = legacyConfig ? hasExistingKey(config, legacyConfig) : false;
    const envAvailable =
      legacyConfig?.envKeys?.some((key) => Boolean(process.env[key]?.trim())) ?? false;

    if (legacyConfig && intent === "switch-active" && (keyConfigured || envAvailable)) {
      const result = existingKey
        ? applySearchKey(config, selectedEntry.value, legacyConfig, existingKey)
        : applyProviderOnly(config, selectedEntry.value);
      const nextConfig = preserveSearchProviderIntent(config, result, intent, selectedEntry.value);
      await runAfterSearchProviderHooks({
        hookRunner,
        originalConfig: config,
        resultConfig: nextConfig,
        provider: providerDetails,
        intent,
        workspaceDir: opts?.workspaceDir,
      });
      return nextConfig;
    }
    if (selectedEntry.configured) {
      const result = preserveSearchProviderIntent(config, next, intent, selectedEntry.value);
      await runAfterSearchProviderHooks({
        hookRunner,
        originalConfig: config,
        resultConfig: result,
        provider: providerDetails,
        intent,
        workspaceDir: opts?.workspaceDir,
      });
      return result;
    }
    if (opts?.quickstartDefaults && selectedEntry.configured) {
      const result = preserveSearchProviderIntent(config, next, intent, selectedEntry.value);
      await runAfterSearchProviderHooks({
        hookRunner,
        originalConfig: config,
        resultConfig: result,
        provider: providerDetails,
        intent,
        workspaceDir: opts?.workspaceDir,
      });
      return result;
    }
    await maybeNoteBeforeSearchProviderConfigure({
      hookRunner,
      config: next,
      provider: providerDetails,
      intent,
      prompter,
      workspaceDir: opts?.workspaceDir,
    });
    if (legacyConfig) {
      const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
      if (useSecretRefMode) {
        if (keyConfigured) {
          return preserveSearchProviderIntent(
            config,
            applyProviderOnly(config, selectedEntry.value),
            intent,
            selectedEntry.value,
          );
        }
        const ref = buildSearchEnvRef(legacyConfig);
        await prompter.note(
          [
            "Secret references enabled — OpenClaw will store a reference instead of the API key.",
            `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
            ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
        const result = preserveSearchProviderIntent(
          config,
          applySearchKey(config, selectedEntry.value, legacyConfig, ref),
          intent,
          selectedEntry.value,
        );
        await runAfterSearchProviderHooks({
          hookRunner,
          originalConfig: config,
          resultConfig: result,
          provider: providerDetails,
          intent,
          workspaceDir: opts?.workspaceDir,
        });
        return result;
      }

      const keyInput = await prompter.text({
        message: keyConfigured
          ? `${selectedEntry.label} API key (leave blank to keep current)`
          : envAvailable
            ? `${selectedEntry.label} API key (leave blank to use env var)`
            : `${selectedEntry.label} API key`,
        placeholder: keyConfigured ? "Leave blank to keep current" : legacyConfig.placeholder,
      });

      const key = keyInput?.trim() ?? "";
      if (key) {
        const secretInput = resolveSearchSecretInput(
          selectedEntry.value,
          legacyConfig,
          key,
          opts?.secretInputMode,
        );
        const result = preserveSearchProviderIntent(
          config,
          applySearchKey(config, selectedEntry.value, legacyConfig, secretInput),
          intent,
          selectedEntry.value,
        );
        await runAfterSearchProviderHooks({
          hookRunner,
          originalConfig: config,
          resultConfig: result,
          provider: providerDetails,
          intent,
          workspaceDir: opts?.workspaceDir,
        });
        return result;
      }

      if (existingKey) {
        const result = preserveSearchProviderIntent(
          config,
          applySearchKey(config, selectedEntry.value, legacyConfig, existingKey),
          intent,
          selectedEntry.value,
        );
        await runAfterSearchProviderHooks({
          hookRunner,
          originalConfig: config,
          resultConfig: result,
          provider: providerDetails,
          intent,
          workspaceDir: opts?.workspaceDir,
        });
        return result;
      }

      if (keyConfigured || envAvailable) {
        const result = preserveSearchProviderIntent(
          config,
          applyProviderOnly(config, selectedEntry.value),
          intent,
          selectedEntry.value,
        );
        await runAfterSearchProviderHooks({
          hookRunner,
          originalConfig: config,
          resultConfig: result,
          provider: providerDetails,
          intent,
          workspaceDir: opts?.workspaceDir,
        });
        return result;
      }

      await prompter.note(
        [
          `Get your key at: ${legacyConfig.signupUrl}`,
          envAvailable
            ? `OpenClaw can also use ${legacyConfig.envKeys?.find((k) => Boolean(process.env[k]?.trim()))}.`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        selectedEntry.label,
      );
      return config;
    }
    const pluginConfigResult = await promptPluginSearchProviderConfig(
      next,
      selectedEntry,
      prompter,
    );
    const result = pluginConfigResult.valid
      ? preserveSearchProviderIntent(config, pluginConfigResult.config, intent, selectedEntry.value)
      : preserveSearchProviderIntent(
          config,
          enabled.config,
          "configure-provider",
          selectedEntry.value,
        );
    await runAfterSearchProviderHooks({
      hookRunner,
      originalConfig: config,
      resultConfig: result,
      provider: providerDetails,
      intent,
      workspaceDir: opts?.workspaceDir,
    });
    return result;
  }
  return config;
}

function preserveSearchProviderIntent(
  original: OpenClawConfig,
  result: OpenClawConfig,
  intent: SearchProviderFlowIntent,
  selectedProvider: string,
): OpenClawConfig {
  if (intent !== "configure-provider") {
    return preserveDisabledState(original, result);
  }

  const currentProvider = resolveCapabilitySlotSelection(original, "providers.search");
  let next = result;
  if (!currentProvider) {
    next = applyCapabilitySlotSelection({
      config: next,
      slot: "providers.search",
      selectedId: selectedProvider,
    });
  } else if (currentProvider !== selectedProvider) {
    next = applyCapabilitySlotSelection({
      config: next,
      slot: "providers.search",
      selectedId: currentProvider,
    });
  }
  return preserveDisabledState(original, next);
}

export async function promptSearchProviderFlow(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  opts?: SetupSearchOptions;
  includeSkipOption: boolean;
  skipHint?: string;
}): Promise<OpenClawConfig> {
  const providerEntries = await resolveSearchProviderPickerEntries(
    params.config,
    params.opts?.workspaceDir,
  );
  const pickerModel = buildSearchProviderPickerModel({
    config: params.config,
    providerEntries,
    includeSkipOption: params.includeSkipOption,
    skipHint: params.skipHint,
  });
  const choice = await params.prompter.select<SearchProviderPickerChoice>({
    message: "Choose web search provider",
    options: buildProviderSelectionOptions({
      intent: "configure-provider",
      options: pickerModel.options,
      activeValue: pickerModel.activeProvider,
    }),
    initialValue: pickerModel.initialValue,
  });

  if (
    choice === SEARCH_PROVIDER_SKIP_SENTINEL ||
    choice === SEARCH_PROVIDER_KEEP_CURRENT_SENTINEL
  ) {
    return params.config;
  }

  const selectedEntry = providerEntries.find((entry) => entry.value === choice);
  const intent: SearchProviderFlowIntent =
    choice === SEARCH_PROVIDER_INSTALL_SENTINEL
      ? "configure-provider"
      : choice === pickerModel.activeProvider
        ? "configure-provider"
        : selectedEntry?.configured
          ? "switch-active"
          : "configure-provider";

  return applySearchProviderChoice({
    config: params.config,
    choice,
    intent,
    runtime: params.runtime,
    prompter: params.prompter,
    opts: params.opts,
  });
}

export function hasKeyInEnv(metadata: SearchProviderLegacyConfigMetadata): boolean {
  return metadata.envKeys.some((key) => Boolean(process.env[key]?.trim()));
}

function rawKeyValue(
  config: OpenClawConfig,
  metadata: SearchProviderLegacyConfigMetadata,
): unknown {
  const search = config.tools?.web?.search;
  return search && typeof search === "object" && metadata.readApiKeyValue
    ? metadata.readApiKeyValue(search as Record<string, unknown>)
    : undefined;
}

/** Returns the plaintext key string, or undefined for SecretRefs/missing. */
export function resolveExistingKey(
  config: OpenClawConfig,
  metadata: SearchProviderLegacyConfigMetadata,
): string | undefined {
  return normalizeSecretInputString(rawKeyValue(config, metadata));
}

/** Returns true if a key is configured (plaintext string or SecretRef). */
export function hasExistingKey(
  config: OpenClawConfig,
  metadata: SearchProviderLegacyConfigMetadata,
): boolean {
  return hasConfiguredSecretInput(rawKeyValue(config, metadata));
}

/** Build an env-backed SecretRef for a search provider. */
function buildSearchEnvRef(metadata: SearchProviderLegacyConfigMetadata): SecretRef {
  const envVar =
    metadata.envKeys?.find((k) => Boolean(process.env[k]?.trim())) ?? metadata.envKeys?.[0];
  if (!envVar) {
    throw new Error("No env var mapping for search provider in secret-input-mode=ref.");
  }
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: envVar };
}

/** Resolve a plaintext key into the appropriate SecretInput based on mode. */
function resolveSearchSecretInput(
  provider: SearchProvider,
  metadata: SearchProviderLegacyConfigMetadata,
  key: string,
  secretInputMode?: SecretInputMode,
): SecretInput {
  const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    return buildSearchEnvRef(metadata);
  }
  return key;
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  metadata: SearchProviderLegacyConfigMetadata,
  key: SecretInput,
): OpenClawConfig {
  const search = { ...config.tools?.web?.search, provider, enabled: true };
  metadata.writeApiKeyValue?.(search as Record<string, unknown>, key);
  return {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
}

function applyProviderOnly(config: OpenClawConfig, provider: SearchProvider): OpenClawConfig {
  const next = applyCapabilitySlotSelection({
    config,
    slot: "providers.search",
    selectedId: provider,
  });
  return {
    ...next,
    tools: {
      ...next.tools,
      web: {
        ...next.tools?.web,
        search: {
          ...next.tools?.web?.search,
          enabled: true,
        },
      },
    },
  };
}

function preserveDisabledState(original: OpenClawConfig, result: OpenClawConfig): OpenClawConfig {
  if (original.tools?.web?.search?.enabled !== false) {
    return result;
  }
  return {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };
}

export type SetupSearchOptions = {
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
  workspaceDir?: string;
};

export async function setupSearch(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Web search lets your agent look things up online.",
      "Choose a provider and enter the required settings.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  return promptSearchProviderFlow({
    config,
    runtime,
    prompter,
    opts,
    includeSkipOption: true,
    skipHint: "Configure later with openclaw configure --section web",
  });
}
