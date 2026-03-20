import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import {
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginId,
} from "../plugins/bundled-web-search.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";

export type SearchProvider = NonNullable<
  NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>["provider"]
>;
type SearchConfig = NonNullable<NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"]>;
type MutableSearchConfig = SearchConfig & Record<string, unknown>;

export const SEARCH_PROVIDER_OPTIONS: readonly PluginWebSearchProviderEntry[] =
  resolvePluginWebSearchProviders({
    bundledAllowlistCompat: true,
  });

function sortSearchProviderOptions(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function canRepairBundledProviderSelection(
  config: OpenClawConfig,
  provider: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
): boolean {
  const pluginId = provider.pluginId ?? resolveBundledWebSearchPluginId(provider.id);
  if (!pluginId) {
    return false;
  }
  if (config.plugins?.enabled === false) {
    return false;
  }
  return !config.plugins?.deny?.includes(pluginId);
}

export function resolveSearchProviderOptions(
  config?: OpenClawConfig,
): readonly PluginWebSearchProviderEntry[] {
  if (!config) {
    return SEARCH_PROVIDER_OPTIONS;
  }

  const merged = new Map<string, PluginWebSearchProviderEntry>(
    resolvePluginWebSearchProviders({
      config,
      bundledAllowlistCompat: true,
      env: process.env,
    }).map((entry) => [entry.id, entry]),
  );

  for (const entry of listBundledWebSearchProviders()) {
    if (merged.has(entry.id) || !canRepairBundledProviderSelection(config, entry)) {
      continue;
    }
    merged.set(entry.id, entry);
  }

  return sortSearchProviderOptions([...merged.values()]);
}

function resolveSearchProviderEntry(
  config: OpenClawConfig,
  provider: SearchProvider,
): PluginWebSearchProviderEntry | undefined {
  return resolveSearchProviderOptions(config).find((entry) => entry.id === provider);
}

export function hasKeyInEnv(entry: Pick<PluginWebSearchProviderEntry, "envVars">): boolean {
  return entry.envVars.some((k) => Boolean(process.env[k]?.trim()));
}

function rawKeyValue(config: OpenClawConfig, provider: SearchProvider): unknown {
  const search = config.tools?.web?.search;
  const entry = resolveSearchProviderEntry(config, provider);
  return (
    entry?.getConfiguredCredentialValue?.(config) ??
    entry?.getCredentialValue(search as Record<string, unknown> | undefined)
  );
}

/** Returns the plaintext key string, or undefined for SecretRefs/missing. */
export function resolveExistingKey(
  config: OpenClawConfig,
  provider: SearchProvider,
): string | undefined {
  return normalizeSecretInputString(rawKeyValue(config, provider));
}

/** Returns true if a key is configured (plaintext string or SecretRef). */
export function hasExistingKey(config: OpenClawConfig, provider: SearchProvider): boolean {
  return hasConfiguredSecretInput(rawKeyValue(config, provider));
}

/** Build an env-backed SecretRef for a search provider. */
function buildSearchEnvRef(config: OpenClawConfig, provider: SearchProvider): SecretRef {
  const entry =
    resolveSearchProviderEntry(config, provider) ??
    SEARCH_PROVIDER_OPTIONS.find((candidate) => candidate.id === provider) ??
    listBundledWebSearchProviders().find((candidate) => candidate.id === provider);
  const envVar = entry?.envVars.find((k) => Boolean(process.env[k]?.trim())) ?? entry?.envVars[0];
  if (!envVar) {
    throw new Error(
      `No env var mapping for search provider "${provider}" at ${entry?.credentialPath ?? "unknown path"} in secret-input-mode=ref.`,
    );
  }
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: envVar };
}

/** Resolve a plaintext key into the appropriate SecretInput based on mode. */
function resolveSearchSecretInput(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: string,
  secretInputMode?: SecretInputMode,
): SecretInput {
  const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    return buildSearchEnvRef(config, provider);
  }
  return key;
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: SecretInput,
): OpenClawConfig {
  const providerEntry = resolveSearchProviderEntry(config, provider);
  if (!providerEntry) {
    return config;
  }
  const search: MutableSearchConfig = { ...config.tools?.web?.search, provider, enabled: true };
  if (!providerEntry.setConfiguredCredentialValue) {
    providerEntry.setCredentialValue(search, key);
  }
  const nextBase: OpenClawConfig = {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
  const next = providerEntry.applySelectionConfig?.(nextBase) ?? nextBase;
  providerEntry.setConfiguredCredentialValue?.(next, key);
  return next;
}

export function applySearchProviderSelection(
  config: OpenClawConfig,
  provider: SearchProvider,
): OpenClawConfig {
  const providerEntry = resolveSearchProviderEntry(config, provider);
  if (!providerEntry) {
    return config;
  }
  const search: MutableSearchConfig = {
    ...config.tools?.web?.search,
    provider,
    enabled: true,
  };
  const nextBase: OpenClawConfig = {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search,
      },
    },
  };
  return providerEntry.applySelectionConfig?.(nextBase) ?? nextBase;
}

function preserveDisabledState(original: OpenClawConfig, result: OpenClawConfig): OpenClawConfig {
  if (original.tools?.web?.search?.enabled !== false) {
    return result;
  }

  const next: OpenClawConfig = {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };

  const provider = next.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return next;
  }
  const providerEntry = resolveSearchProviderEntry(original, provider);
  if (!providerEntry?.pluginId) {
    return next;
  }

  const pluginId = providerEntry.pluginId;
  const originalPluginEntry = (
    original.plugins?.entries as Record<string, Record<string, unknown>> | undefined
  )?.[pluginId];
  const resultPluginEntry = (
    next.plugins?.entries as Record<string, Record<string, unknown>> | undefined
  )?.[pluginId];

  const nextPlugins = { ...next.plugins } as Record<string, unknown>;

  if (Array.isArray(original.plugins?.allow)) {
    nextPlugins.allow = [...original.plugins.allow];
  } else {
    delete nextPlugins.allow;
  }

  if (resultPluginEntry || originalPluginEntry) {
    const nextEntries = {
      ...(nextPlugins.entries as Record<string, Record<string, unknown>> | undefined),
    };
    const patchedEntry = { ...resultPluginEntry };
    if (typeof originalPluginEntry?.enabled === "boolean") {
      patchedEntry.enabled = originalPluginEntry.enabled;
    } else {
      delete patchedEntry.enabled;
    }
    nextEntries[pluginId] = patchedEntry;
    nextPlugins.entries = nextEntries;
  }

  return {
    ...next,
    plugins: nextPlugins as OpenClawConfig["plugins"],
  };
}

export type SetupSearchOptions = {
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
};

export async function setupSearch(
  config: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  const providerOptions = resolveSearchProviderOptions(config);
  if (providerOptions.length === 0) {
    await prompter.note(
      [
        "No web search providers are currently available under this plugin policy.",
        "Enable plugins or remove deny rules, then run setup again.",
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    return config;
  }

  await prompter.note(
    [
      "Web search lets your agent look things up online.",
      "Choose a provider and paste your API key.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const existingProvider = config.tools?.web?.search?.provider;

  const options = providerOptions.map((entry) => {
    const configured = hasExistingKey(config, entry.id) || hasKeyInEnv(entry);
    const hint = configured ? `${entry.hint} · configured` : entry.hint;
    return { value: entry.id, label: entry.label, hint };
  });

  const defaultProvider: SearchProvider = (() => {
    if (existingProvider && providerOptions.some((entry) => entry.id === existingProvider)) {
      return existingProvider;
    }
    const detected = providerOptions.find((e) => hasExistingKey(config, e.id) || hasKeyInEnv(e));
    if (detected) {
      return detected.id;
    }
    return providerOptions[0].id;
  })();

  const choice = await prompter.select({
    message: "Search provider",
    options: [
      ...options,
      {
        value: "__skip__" as const,
        label: "Skip for now",
        hint: "Configure later with openclaw configure --section web",
      },
    ],
    initialValue: defaultProvider,
  });

  if (choice === "__skip__") {
    return config;
  }

  const entry =
    resolveSearchProviderEntry(config, choice) ?? providerOptions.find((e) => e.id === choice);
  if (!entry) {
    return config;
  }
  const existingKey = resolveExistingKey(config, choice);
  const keyConfigured = hasExistingKey(config, choice);
  const envAvailable = hasKeyInEnv(entry);

  if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) {
    const result = existingKey
      ? applySearchKey(config, choice, existingKey)
      : applySearchProviderSelection(config, choice);
    return preserveDisabledState(config, result);
  }

  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    if (keyConfigured) {
      return preserveDisabledState(config, applySearchProviderSelection(config, choice));
    }
    const ref = buildSearchEnvRef(config, choice);
    await prompter.note(
      [
        "Secret references enabled — OpenClaw will store a reference instead of the API key.",
        `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
        ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    return applySearchKey(config, choice, ref);
  }

  const keyInput = await prompter.text({
    message: keyConfigured
      ? `${entry.label} API key (leave blank to keep current)`
      : envAvailable
        ? `${entry.label} API key (leave blank to use env var)`
        : `${entry.label} API key`,
    placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
  });

  const key = keyInput?.trim() ?? "";
  if (key) {
    const secretInput = resolveSearchSecretInput(config, choice, key, opts?.secretInputMode);
    return applySearchKey(config, choice, secretInput);
  }

  if (existingKey) {
    return preserveDisabledState(config, applySearchKey(config, choice, existingKey));
  }

  if (keyConfigured || envAvailable) {
    return preserveDisabledState(config, applySearchProviderSelection(config, choice));
  }

  await prompter.note(
    [
      "No API key stored — web_search won't work until a key is available.",
      `Get your key at: ${entry.signupUrl}`,
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const search: SearchConfig = {
    ...config.tools?.web?.search,
    provider: choice,
  };
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search,
      },
    },
  };
}
