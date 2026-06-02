import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { getMemoryRuntime } from "./memory-state.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";

function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const memorySlot = plugins.slots.memory;
  if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) {
    return [];
  }
  const pluginId = memorySlot.trim();
  // The memory slot is an explicit runtime owner. Honor deny/disabled policy so
  // lazy memory loading cannot revive a plugin the operator blocked.
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
  // Standalone runtime loading uses the default agent workspace so memory
  // plugins resolve the same local paths as the agent that will query them.
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
  // Prefer the already-loaded runtime registry first. Only fall back to the
  // standalone loader when the selected memory plugin was not part of startup.
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

/** Returns the active memory search manager, loading the selected memory plugin if needed. */
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

/** Resolves backend config from the active memory runtime, or null when unavailable. */
export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}

/** Closes every memory search manager registered by the active memory runtime. */
export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}

/** Closes the memory search manager for one agent when the runtime supports it. */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const runtime = getMemoryRuntime();
  await runtime?.closeMemorySearchManager?.(params);
}
