import { createFirecrawlWebSearchProvider } from "../../extensions/firecrawl/src/firecrawl-search-provider.js";
import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  setScopedCredentialValue,
  setTopLevelCredentialValue,
} from "../agents/tools/web-search-plugin-factory.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

const BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS = [
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "xai",
] as const;

const BUNDLED_WEB_SEARCH_PROVIDER_REGISTRY = [
  {
    pluginId: "brave",
    provider: createPluginBackedWebSearchProvider({
      id: "brave",
      label: "Brave Search",
      hint: "Structured results · country/language/time filters",
      envVars: ["BRAVE_API_KEY"],
      placeholder: "BSA...",
      signupUrl: "https://brave.com/search/api/",
      docsUrl: "https://docs.openclaw.ai/brave-search",
      autoDetectOrder: 10,
      getCredentialValue: getTopLevelCredentialValue,
      setCredentialValue: setTopLevelCredentialValue,
    }),
  },
  {
    pluginId: "google",
    provider: createPluginBackedWebSearchProvider({
      id: "gemini",
      label: "Gemini (Google Search)",
      hint: "Google Search grounding · AI-synthesized",
      envVars: ["GEMINI_API_KEY"],
      placeholder: "AIza...",
      signupUrl: "https://aistudio.google.com/apikey",
      docsUrl: "https://docs.openclaw.ai/tools/web",
      autoDetectOrder: 20,
      getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "gemini"),
      setCredentialValue: (searchConfigTarget, value) =>
        setScopedCredentialValue(searchConfigTarget, "gemini", value),
    }),
  },
  {
    pluginId: "xai",
    provider: createPluginBackedWebSearchProvider({
      id: "grok",
      label: "Grok (xAI)",
      hint: "xAI web-grounded responses",
      envVars: ["XAI_API_KEY"],
      placeholder: "xai-...",
      signupUrl: "https://console.x.ai/",
      docsUrl: "https://docs.openclaw.ai/tools/web",
      autoDetectOrder: 30,
      getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "grok"),
      setCredentialValue: (searchConfigTarget, value) =>
        setScopedCredentialValue(searchConfigTarget, "grok", value),
    }),
  },
  {
    pluginId: "moonshot",
    provider: createPluginBackedWebSearchProvider({
      id: "kimi",
      label: "Kimi (Moonshot)",
      hint: "Moonshot web search",
      envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
      placeholder: "sk-...",
      signupUrl: "https://platform.moonshot.cn/",
      docsUrl: "https://docs.openclaw.ai/tools/web",
      autoDetectOrder: 40,
      getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "kimi"),
      setCredentialValue: (searchConfigTarget, value) =>
        setScopedCredentialValue(searchConfigTarget, "kimi", value),
    }),
  },
  {
    pluginId: "perplexity",
    provider: createPluginBackedWebSearchProvider({
      id: "perplexity",
      label: "Perplexity Search",
      hint: "Structured results · domain/country/language/time filters",
      envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
      placeholder: "pplx-...",
      signupUrl: "https://www.perplexity.ai/settings/api",
      docsUrl: "https://docs.openclaw.ai/perplexity",
      autoDetectOrder: 50,
      getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "perplexity"),
      setCredentialValue: (searchConfigTarget, value) =>
        setScopedCredentialValue(searchConfigTarget, "perplexity", value),
    }),
  },
  {
    pluginId: "firecrawl",
    provider: createFirecrawlWebSearchProvider(),
  },
] as const;

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): PluginWebSearchProviderEntry[] {
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
      })
    : params.config;
  const config = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
  });
  const normalizedPlugins = normalizePluginsConfig(config?.plugins);

  return BUNDLED_WEB_SEARCH_PROVIDER_REGISTRY.filter(
    ({ pluginId }) =>
      resolveEffectiveEnableState({
        id: pluginId,
        origin: "bundled",
        config: normalizedPlugins,
        rootConfig: config,
      }).enabled,
  )
    .map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }))
    .toSorted((a, b) => {
      const aOrder = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return a.id.localeCompare(b.id);
    });
}
