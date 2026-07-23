// Runtime bridge for plugin-owned memory hooks and state.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  getMemoryRuntime,
  getMemoryRuntimeForPlugin,
  listMemoryRuntimeRegistrations,
} from "./memory-state.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";
import { resolveMemoryRoleSlot } from "./slot-resolution.js";

/** Resolves the configured memory slot to the single runtime plugin that may load memory. */
function resolveMemoryRuntimePluginIds(config: OpenClawConfig, agentId: string): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const memorySlot = resolveMemoryRoleSlot({ cfg: config, role: "recall", agentId });
  if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) {
    return [];
  }
  const pluginId = memorySlot.trim();
  if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
    return [];
  }
  return [pluginId];
}

function resolveMemoryRuntimeWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const dir = resolveAgentWorkspaceDir(cfg, agentId);
  if (typeof dir !== "string" || !dir.trim()) {
    return undefined;
  }
  return resolveUserPath(dir);
}

function resolveEffectiveMemoryRuntimeAgentId(cfg: OpenClawConfig, agentId?: string): string {
  return agentId ?? resolveDefaultAgentId(cfg);
}

function ensureMemoryRuntime(cfg?: OpenClawConfig, agentId?: string) {
  if (!cfg) {
    return getMemoryRuntime();
  }
  const effectiveAgentId = resolveEffectiveMemoryRuntimeAgentId(cfg, agentId);
  const onlyPluginIds = resolveMemoryRuntimePluginIds(cfg, effectiveAgentId);
  if (onlyPluginIds.length === 0) {
    return undefined;
  }
  const selectedPluginId = onlyPluginIds[0];
  if (!selectedPluginId) {
    return undefined;
  }
  const current = getMemoryRuntimeForPlugin(selectedPluginId);
  if (current) {
    return current;
  }
  getLoadedRuntimePluginRegistry({ requiredPluginIds: onlyPluginIds });
  const runtimeAfterActiveLoad = getMemoryRuntimeForPlugin(selectedPluginId);
  if (runtimeAfterActiveLoad) {
    return runtimeAfterActiveLoad;
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(cfg, effectiveAgentId);
  ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: onlyPluginIds,
    loadOptions: {
      config: cfg,
      onlyPluginIds,
      workspaceDir,
    },
  });
  return getMemoryRuntimeForPlugin(selectedPluginId);
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  purpose?: "default" | "status" | "cli";
}) {
  const effectiveAgentId = resolveEffectiveMemoryRuntimeAgentId(params.cfg, params.agentId);
  const runtime = ensureMemoryRuntime(params.cfg, effectiveAgentId);
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  return await runtime.getMemorySearchManager({ ...params, agentId: effectiveAgentId });
}

/** Resolves current memory backend config without constructing a manager. */
export function resolveActiveMemoryBackendConfig(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}) {
  const effectiveAgentId = resolveEffectiveMemoryRuntimeAgentId(params.cfg, params.agentId);
  return (
    ensureMemoryRuntime(params.cfg, effectiveAgentId)?.resolveMemoryBackendConfig({
      ...params,
      agentId: effectiveAgentId,
    }) ?? null
  );
}

/** Closes all active plugin-backed memory search managers. */
export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtimes = new Set(
    [
      getMemoryRuntime(),
      ...listMemoryRuntimeRegistrations().map((registration) => registration.runtime),
    ].filter((runtime) => typeof runtime?.closeAllMemorySearchManagers === "function"),
  );
  for (const runtime of runtimes) {
    await runtime?.closeAllMemorySearchManagers?.();
  }
}

/** Closes the plugin-backed memory search manager for one agent. */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const [selectedPluginId] = resolveMemoryRuntimePluginIds(params.cfg, params.agentId);
  const runtime = selectedPluginId ? getMemoryRuntimeForPlugin(selectedPluginId) : undefined;
  await runtime?.closeMemorySearchManager?.(params);
}
