import bravePlugin from "../../extensions/brave/index.js";
import firecrawlPlugin from "../../extensions/firecrawl/index.js";
import googlePlugin from "../../extensions/google/index.js";
import moonshotPlugin from "../../extensions/moonshot/index.js";
import perplexityPlugin from "../../extensions/perplexity/index.js";
import xaiPlugin from "../../extensions/xai/index.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderRegistration } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";
import type { OpenClawPluginApi, WebSearchProviderPlugin } from "./types.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

type RegistrablePlugin = {
  id: string;
  name: string;
  register: (api: OpenClawPluginApi) => void;
};

const BUNDLED_WEB_SEARCH_PLUGINS: readonly RegistrablePlugin[] = [
  bravePlugin,
  firecrawlPlugin,
  googlePlugin,
  moonshotPlugin,
  perplexityPlugin,
  xaiPlugin,
];

const BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS = BUNDLED_WEB_SEARCH_PLUGINS.map(
  (plugin) => plugin.id,
);

function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted((a, b) => {
    const aOrder = a.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

function mapWebSearchProviderEntries(
  entries: PluginWebSearchProviderRegistration[],
): PluginWebSearchProviderEntry[] {
  return sortWebSearchProviders(
    entries.map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    })),
  );
}

function normalizeWebSearchPluginConfig(params: {
  config?: PluginLoadOptions["config"];
  bundledAllowlistCompat?: boolean;
}): PluginLoadOptions["config"] {
  const allowlistCompat = params.bundledAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
      })
    : params.config;
  return withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: BUNDLED_WEB_SEARCH_ALLOWLIST_COMPAT_PLUGIN_IDS,
  });
}

function captureBundledWebSearchProviders(
  plugin: RegistrablePlugin,
): PluginWebSearchProviderRegistration[] {
  const providers: WebSearchProviderPlugin[] = [];
  const api = {
    registerProvider() {},
    registerSpeechProvider() {},
    registerMediaUnderstandingProvider() {},
    registerWebSearchProvider(provider: WebSearchProviderPlugin) {
      providers.push(provider);
    },
    registerTool() {},
  };
  plugin.register(api as unknown as OpenClawPluginApi);
  return providers.map((provider) => ({
    pluginId: plugin.id,
    pluginName: plugin.name,
    provider,
    source: "bundled",
  }));
}

function resolveBundledWebSearchRegistrations(params: {
  config?: PluginLoadOptions["config"];
  bundledAllowlistCompat?: boolean;
}): PluginWebSearchProviderRegistration[] {
  const config = normalizeWebSearchPluginConfig(params);
  if (config?.plugins?.enabled === false) {
    return [];
  }
  const allowlist = config?.plugins?.allow
    ? new Set(config.plugins.allow.map((entry) => entry.trim()).filter(Boolean))
    : null;
  return BUNDLED_WEB_SEARCH_PLUGINS.flatMap((plugin) => {
    if (allowlist && !allowlist.has(plugin.id)) {
      return [];
    }
    if (config?.plugins?.entries?.[plugin.id]?.enabled === false) {
      return [];
    }
    return captureBundledWebSearchProviders(plugin);
  });
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): PluginWebSearchProviderEntry[] {
  return mapWebSearchProviderEntries(resolveBundledWebSearchRegistrations(params));
}

export function resolveRuntimeWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): PluginWebSearchProviderEntry[] {
  const runtimeProviders = getActivePluginRegistry()?.webSearchProviders ?? [];
  if (runtimeProviders.length > 0) {
    return mapWebSearchProviderEntries(runtimeProviders);
  }
  return resolvePluginWebSearchProviders(params);
}
