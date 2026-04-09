import type { OpenClawConfig } from "../config/config.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { getMemoryRuntime } from "./memory-state.js";
import { hasKind } from "./slots.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";

function resolveMemoryBootstrapPluginIds(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const pluginIds = new Set<string>();
  const normalizedPlugins = normalizePluginsConfig(params.cfg.plugins);
  if (normalizedPlugins.slots.memory && normalizedPlugins.slots.memory !== "none") {
    pluginIds.add(normalizedPlugins.slots.memory);
  }
  for (const plugin of loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
  }).plugins) {
    if (hasKind(plugin.kind, "memory")) {
      pluginIds.add(plugin.id);
    }
  }
  return [...pluginIds];
}

function ensureMemoryRuntime(cfg?: OpenClawConfig) {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    return current;
  }
  const context = resolvePluginRuntimeLoadContext({ config: cfg });
  const onlyPluginIds = resolveMemoryBootstrapPluginIds({
    cfg: context.config,
    workspaceDir: context.workspaceDir,
    env: context.env,
  });
  resolveRuntimePluginRegistry(
    buildPluginRuntimeLoadOptions(context, {
      ...(onlyPluginIds.length > 0 ? { onlyPluginIds } : {}),
    }),
  );
  return getMemoryRuntime();
}

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}) {
  const runtime = ensureMemoryRuntime(params.cfg);
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  return await runtime.getMemorySearchManager(params);
}

export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}

export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}
