import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");
const BUNDLED_PROVIDER_ALLOWLIST_COMPAT_PLUGIN_IDS = [
  "byteplus",
  "cloudflare-ai-gateway",
  "copilot-proxy",
  "github-copilot",
  "google-gemini-cli-auth",
  "huggingface",
  "kilocode",
  "kimi-coding",
  "minimax",
  "minimax-portal-auth",
  "modelstudio",
  "moonshot",
  "nvidia",
  "ollama",
  "openai-codex",
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
] as const;

function withBundledProviderAllowlistCompat(
  config: PluginLoadOptions["config"],
): PluginLoadOptions["config"] {
  const allow = config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return config;
  }

  const allowSet = new Set(allow.map((entry) => entry.trim()).filter(Boolean));
  let changed = false;
  for (const pluginId of BUNDLED_PROVIDER_ALLOWLIST_COMPAT_PLUGIN_IDS) {
    if (!allowSet.has(pluginId)) {
      allowSet.add(pluginId);
      changed = true;
    }
  }

  if (!changed) {
    return config;
  }

  return {
    ...config,
    plugins: {
      ...config?.plugins,
      // Backward compat: bundled implicit providers historically stayed
      // available even when operators kept a restrictive plugin allowlist.
      allow: [...allowSet],
    },
  };
}

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
}): ProviderPlugin[] {
  const config = params.bundledProviderAllowlistCompat
    ? withBundledProviderAllowlistCompat(params.config)
    : params.config;
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    logger: createPluginLoaderLogger(log),
  });

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
