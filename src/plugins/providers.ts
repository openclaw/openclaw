import { normalizeProviderId } from "../agents/model-selection.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withBundledPluginAllowlistCompat } from "./bundled-compat.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");
const BUNDLED_PROVIDER_ALLOWLIST_COMPAT_PLUGIN_IDS = [
  "anthropic",
  "byteplus",
  "cloudflare-ai-gateway",
  "copilot-proxy",
  "github-copilot",
  "google",
  "huggingface",
  "kilocode",
  "kimi-coding",
  "minimax",
  "mistral",
  "modelstudio",
  "moonshot",
  "nvidia",
  "ollama",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "qwen-portal-auth",
  "sglang",
  "synthetic",
  "together",
  "venice",
  "vercel-ai-gateway",
  "volcengine",
  "vllm",
  "xiaomi",
  "zai",
] as const;

function hasExplicitPluginConfig(config: PluginLoadOptions["config"]): boolean {
  const plugins = config?.plugins;
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  return false;
}

function withBundledProviderVitestCompat(params: {
  config: PluginLoadOptions["config"];
  env?: PluginLoadOptions["env"];
}): PluginLoadOptions["config"] {
  const env = params.env ?? process.env;
  if (!env.VITEST || hasExplicitPluginConfig(params.config)) {
    return params.config;
  }

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      enabled: true,
      allow: [...BUNDLED_PROVIDER_ALLOWLIST_COMPAT_PLUGIN_IDS],
      slots: {
        ...params.config?.plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function resolveOwningPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }

  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const pluginIds = registry.plugins
    .filter((plugin) =>
      plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider),
    )
    .map((plugin) => plugin.id);

  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
}): ProviderPlugin[] {
  const maybeAllowlistCompat = params.bundledProviderAllowlistCompat
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: BUNDLED_PROVIDER_ALLOWLIST_COMPAT_PLUGIN_IDS,
      })
    : params.config;
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: maybeAllowlistCompat,
        env: params.env,
      })
    : maybeAllowlistCompat;
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    logger: createPluginLoaderLogger(log),
  });

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
