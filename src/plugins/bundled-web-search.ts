import {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-provider-config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { enablePluginInConfig } from "./enable.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry, WebSearchRuntimeMetadataContext } from "./types.js";

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

type BundledWebSearchProviderDescriptor = {
  pluginId: string;
  id: string;
  label: string;
  hint: string;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder: number;
  credentialPath: string;
  inactiveSecretPaths: string[];
  credentialScope:
    | { kind: "top-level" }
    | {
        kind: "scoped";
        key: string;
      };
  supportsConfiguredCredentialValue?: boolean;
  applySelectionConfig?: (config: OpenClawConfig) => OpenClawConfig;
  resolveRuntimeMetadata?: (
    ctx: WebSearchRuntimeMetadataContext,
  ) => Partial<RuntimeWebSearchMetadata>;
};

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): "direct" | "openrouter" | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRuntimeMetadata(
  ctx: WebSearchRuntimeMetadataContext,
): Partial<RuntimeWebSearchMetadata> {
  const perplexity = ctx.searchConfig?.perplexity;
  const scoped =
    perplexity && typeof perplexity === "object" && !Array.isArray(perplexity)
      ? (perplexity as { baseUrl?: string; model?: string })
      : undefined;
  const configuredBaseUrl = typeof scoped?.baseUrl === "string" ? scoped.baseUrl.trim() : "";
  const configuredModel = typeof scoped?.model === "string" ? scoped.model.trim() : "";
  const keySource = ctx.resolvedCredential?.source ?? "missing";
  const baseUrl = (() => {
    if (configuredBaseUrl) {
      return configuredBaseUrl;
    }
    if (keySource === "env") {
      if (ctx.resolvedCredential?.fallbackEnvVar === "PERPLEXITY_API_KEY") {
        return PERPLEXITY_DIRECT_BASE_URL;
      }
      if (ctx.resolvedCredential?.fallbackEnvVar === "OPENROUTER_API_KEY") {
        return DEFAULT_PERPLEXITY_BASE_URL;
      }
    }
    if ((keySource === "config" || keySource === "secretRef") && ctx.resolvedCredential?.value) {
      return inferPerplexityBaseUrlFromApiKey(ctx.resolvedCredential.value) === "openrouter"
        ? DEFAULT_PERPLEXITY_BASE_URL
        : PERPLEXITY_DIRECT_BASE_URL;
    }
    return DEFAULT_PERPLEXITY_BASE_URL;
  })();
  return {
    perplexityTransport:
      configuredBaseUrl || configuredModel || !isDirectPerplexityBaseUrl(baseUrl)
        ? "chat_completions"
        : "search_api",
  };
}

const BUNDLED_WEB_SEARCH_PROVIDER_DESCRIPTORS = [
  {
    pluginId: "brave",
    id: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    docsUrl: "https://docs.openclaw.ai/brave-search",
    autoDetectOrder: 10,
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.brave.config.webSearch.apiKey"],
    credentialScope: { kind: "top-level" },
  },
  {
    pluginId: "google",
    id: "gemini",
    label: "Gemini (Google Search)",
    hint: "Google Search grounding · AI-synthesized",
    envVars: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 20,
    credentialPath: "plugins.entries.google.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.google.config.webSearch.apiKey"],
    credentialScope: { kind: "scoped", key: "gemini" },
  },
  {
    pluginId: "xai",
    id: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    credentialScope: { kind: "scoped", key: "grok" },
    supportsConfiguredCredentialValue: false,
  },
  {
    pluginId: "moonshot",
    id: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Moonshot web search",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 40,
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.moonshot.config.webSearch.apiKey"],
    credentialScope: { kind: "scoped", key: "kimi" },
  },
  {
    pluginId: "perplexity",
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Structured results · domain/country/language/time filters",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    docsUrl: "https://docs.openclaw.ai/perplexity",
    autoDetectOrder: 50,
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.perplexity.config.webSearch.apiKey"],
    credentialScope: { kind: "scoped", key: "perplexity" },
    resolveRuntimeMetadata: resolvePerplexityRuntimeMetadata,
  },
  {
    pluginId: "firecrawl",
    id: "firecrawl",
    label: "Firecrawl Search",
    hint: "Structured results with optional result scraping",
    envVars: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    signupUrl: "https://www.firecrawl.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    autoDetectOrder: 60,
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
    credentialScope: { kind: "scoped", key: "firecrawl" },
    applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
  },
  {
    pluginId: "tavily",
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured results with domain filters and AI answer summaries",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    autoDetectOrder: 70,
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.tavily.config.webSearch.apiKey"],
    credentialScope: { kind: "scoped", key: "tavily" },
    applySelectionConfig: (config) => enablePluginInConfig(config, "tavily").config,
  },
] as const satisfies ReadonlyArray<BundledWebSearchProviderDescriptor>;

export const BUNDLED_WEB_SEARCH_PLUGIN_IDS = [
  ...new Set(BUNDLED_WEB_SEARCH_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.pluginId)),
] as ReadonlyArray<BundledWebSearchProviderDescriptor["pluginId"]>;

const bundledWebSearchPluginIdSet = new Set<string>(BUNDLED_WEB_SEARCH_PLUGIN_IDS);

function buildBundledWebSearchProviderEntry(
  descriptor: BundledWebSearchProviderDescriptor,
): PluginWebSearchProviderEntry {
  const scopedKey =
    descriptor.credentialScope.kind === "scoped" ? descriptor.credentialScope.key : undefined;
  return {
    pluginId: descriptor.pluginId,
    id: descriptor.id,
    label: descriptor.label,
    hint: descriptor.hint,
    envVars: [...descriptor.envVars],
    placeholder: descriptor.placeholder,
    signupUrl: descriptor.signupUrl,
    docsUrl: descriptor.docsUrl,
    autoDetectOrder: descriptor.autoDetectOrder,
    credentialPath: descriptor.credentialPath,
    inactiveSecretPaths: [...descriptor.inactiveSecretPaths],
    getCredentialValue:
      descriptor.credentialScope.kind === "top-level"
        ? getTopLevelCredentialValue
        : (searchConfig) => getScopedCredentialValue(searchConfig, scopedKey!),
    setCredentialValue:
      descriptor.credentialScope.kind === "top-level"
        ? setTopLevelCredentialValue
        : (searchConfigTarget, value) =>
            setScopedCredentialValue(searchConfigTarget, scopedKey!, value),
    getConfiguredCredentialValue:
      descriptor.supportsConfiguredCredentialValue === false
        ? undefined
        : (config) => resolveProviderWebSearchPluginConfig(config, descriptor.pluginId)?.apiKey,
    setConfiguredCredentialValue:
      descriptor.supportsConfiguredCredentialValue === false
        ? undefined
        : (configTarget, value) => {
            setProviderWebSearchPluginConfigValue(
              configTarget,
              descriptor.pluginId,
              "apiKey",
              value,
            );
          },
    applySelectionConfig: descriptor.applySelectionConfig,
    resolveRuntimeMetadata: descriptor.resolveRuntimeMetadata,
    createTool: () => null,
  };
}

export function resolveBundledWebSearchPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return registry.plugins
    .filter((plugin) => plugin.origin === "bundled" && bundledWebSearchPluginIdSet.has(plugin.id))
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return BUNDLED_WEB_SEARCH_PROVIDER_DESCRIPTORS.map((descriptor) =>
    buildBundledWebSearchProviderEntry(descriptor),
  );
}

export function resolveBundledWebSearchPluginId(
  providerId: string | undefined,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  return BUNDLED_WEB_SEARCH_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === providerId)
    ?.pluginId;
}
