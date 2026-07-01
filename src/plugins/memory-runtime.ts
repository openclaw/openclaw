// Runtime bridge for plugin-owned memory hooks and state.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { getMemoryRuntime } from "./memory-state.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";

/** Resolves the configured memory slot to the single runtime plugin that may load memory. */
function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const memorySlot = plugins.slots.memory;
  if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) {
    return [];
  }
  const pluginId = memorySlot.trim();
  if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
    return [];
  }
  return [pluginId];
}

function resolveMemoryRuntimeWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  const agentId = resolveDefaultAgentId(cfg);
  const dir = resolveAgentWorkspaceDir(cfg, agentId);
  if (typeof dir !== "string" || !dir.trim()) {
    return undefined;
  }
  return resolveUserPath(dir);
}

function ensureMemoryRuntime(cfg?: OpenClawConfig) {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    return current;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(cfg);
  if (onlyPluginIds.length === 0) {
    return getMemoryRuntime();
  }
  getLoadedRuntimePluginRegistry({ requiredPluginIds: onlyPluginIds });
  if (getMemoryRuntime()) {
    return getMemoryRuntime();
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(cfg);
  ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: onlyPluginIds,
    loadOptions: {
      config: cfg,
      onlyPluginIds,
      workspaceDir,
    },
  });
  return getMemoryRuntime();
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
}) {
  const runtime = ensureMemoryRuntime(params.cfg);
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  return await runtime.getMemorySearchManager(params);
}

/** Resolves current memory backend config without constructing a manager. */
export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}

/** Closes all active plugin-backed memory search managers. */
export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}

/**
 * Closes the plugin-backed memory search manager for one agent. With scope
 * "index-managers" it releases only the disposable local index managers and
 * keeps the shared manager alive, used by active-memory recall-timeout cleanup
 * so a request-scoped timeout does not tear down the long-lived QMD manager
 * (#96455).
 */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  scope?: "manager" | "index-managers";
}): Promise<void> {
  const runtime = getMemoryRuntime();
  const target = { cfg: params.cfg, agentId: params.agentId };
  if (params.scope === "index-managers" && runtime?.releaseMemoryIndexManagers) {
    // memory-core implements the narrow hook, so recall-timeout cleanup releases
    // only the disposable index managers and leaves the shared QMD manager alive
    // (#96455). A runtime without it falls through to the legacy close below, so
    // its prior post-timeout cleanup (#84048) is not silently dropped.
    await runtime.releaseMemoryIndexManagers(target);
    return;
  }
  await runtime?.closeMemorySearchManager?.(target);
}
