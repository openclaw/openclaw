import { ensureRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";

export type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "duckduckgo";
type Surface = "webSearch" | "webFetch";
export { ensureRecord };

export function createWebCredentialEntry(
  surface: Surface,
  apiKey: unknown,
  options: { enabled?: boolean } = {},
) {
  return { ...options, config: { [surface]: { apiKey } } };
}

export function providerPluginId(provider: ProviderUnderTest): string {
  const aliases: Partial<Record<ProviderUnderTest, string>> = {
    gemini: "google",
    grok: "xai",
    kimi: "moonshot",
  };
  return aliases[provider] ?? provider;
}

function configuredKey(config: OpenClawConfig | undefined, pluginId: string, surface: Surface) {
  const entry = config?.plugins?.entries?.[pluginId]?.config;
  return entry && typeof entry === "object"
    ? (entry as Partial<Record<Surface, { apiKey?: unknown }>>)[surface]?.apiKey
    : undefined;
}

function baseProvider(id: string, pluginId: string, order: number, surface: Surface) {
  const credentialPath = `plugins.entries.${pluginId}.config.${surface}.apiKey`;
  return {
    id,
    pluginId,
    label: id,
    hint: `${id} test provider`,
    envVars: [`${id.toUpperCase()}_API_KEY`],
    placeholder: `${id}-...`,
    signupUrl: `https://example.com/${id}`,
    autoDetectOrder: order,
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: (config?: Record<string, unknown>) => config?.apiKey,
    setCredentialValue: (config: Record<string, unknown>, value: unknown) => {
      config.apiKey = value;
    },
    getConfiguredCredentialValue: (config?: OpenClawConfig) =>
      configuredKey(config, pluginId, surface),
    setConfiguredCredentialValue: (config: OpenClawConfig, value: unknown) => {
      const plugins = ensureRecord(config as Record<string, unknown>, "plugins");
      const entries = ensureRecord(plugins, "entries");
      const entry = ensureRecord(entries, pluginId);
      ensureRecord(ensureRecord(entry, "config"), surface).apiKey = value;
    },
    createTool: () => null,
  };
}

export function createTestProvider(params: {
  provider: ProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const { provider, pluginId, order } = params;
  return {
    ...baseProvider(provider, pluginId, order, "webSearch"),
    ...(provider === "duckduckgo"
      ? {
          requiresCredential: false,
          envVars: [],
          placeholder: "(no key needed)",
          credentialPath: "",
          inactiveSecretPaths: [],
          getCredentialValue: () => "duckduckgo-no-key-needed",
        }
      : { requiresCredential: undefined }),
    getConfiguredCredentialFallback: (config) => {
      if (provider !== "gemini") {
        return undefined;
      }
      const google = config?.models?.providers?.google;
      return google && typeof google === "object" && "apiKey" in google
        ? { path: "models.providers.google.apiKey", value: (google as { apiKey?: unknown }).apiKey }
        : undefined;
    },
    resolveRuntimeMetadata:
      provider === "perplexity"
        ? () => ({ perplexityTransport: "search_api" as const })
        : undefined,
  };
}

export function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return (["brave", "gemini", "grok", "kimi", "perplexity", "duckduckgo"] as const).map(
    (provider, index) =>
      createTestProvider({
        provider,
        pluginId: providerPluginId(provider),
        order: provider === "duckduckgo" ? 100 : (index + 1) * 10,
      }),
  );
}

export function buildTestWebFetchProviders(): PluginWebFetchProviderEntry[] {
  return [
    {
      ...baseProvider("firecrawl", "firecrawl", 50, "webFetch"),
      requiresCredential: false,
      placeholder: "fc-...",
      getConfiguredCredentialFallback: (config) => {
        const apiKey = configuredKey(config, "firecrawl", "webSearch");
        return apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: apiKey,
            };
      },
    },
  ];
}
