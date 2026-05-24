import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { getMemoryRuntime } from "./memory-state.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";

function hasOwnSlot(slots: unknown, slotKey: string): boolean {
  return Boolean(
    slots && typeof slots === "object" && Object.prototype.hasOwnProperty.call(slots, slotKey),
  );
}

function resolveMemoryRuntimePluginIds(config: OpenClawConfig, agentId?: string): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  let memorySlot = plugins.slots["memory.recall"] ?? plugins.slots.memory;
  const agentSlots = agentId ? resolveAgentConfig(config, agentId)?.plugins?.slots : undefined;
  if (hasOwnSlot(agentSlots, "memory.recall") || hasOwnSlot(agentSlots, "memory")) {
    const agentPlugins = normalizePluginsConfig({ slots: agentSlots });
    memorySlot = hasOwnSlot(agentSlots, "memory.recall")
      ? agentPlugins.slots["memory.recall"]
      : agentPlugins.slots.memory;
  }
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
  agentId = resolveDefaultAgentId(cfg),
): string | undefined {
  const dir = resolveAgentWorkspaceDir(cfg, agentId);
  if (typeof dir !== "string" || !dir.trim()) {
    return undefined;
  }
  return resolveUserPath(dir);
}

function ensureMemoryRuntime(cfg?: OpenClawConfig, agentId?: string) {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    return current;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(cfg, agentId);
  if (onlyPluginIds.length === 0) {
    return getMemoryRuntime();
  }
  getLoadedRuntimePluginRegistry({ requiredPluginIds: onlyPluginIds });
  if (getMemoryRuntime()) {
    return getMemoryRuntime();
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(cfg, agentId);
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

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
}) {
  const runtime = ensureMemoryRuntime(params.cfg, params.agentId);
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  return await runtime.getMemorySearchManager(params);
}

export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return (
    ensureMemoryRuntime(params.cfg, params.agentId)?.resolveMemoryBackendConfig(params) ?? null
  );
}

export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}

export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const runtime = getMemoryRuntime();
  await runtime?.closeMemorySearchManager?.(params);
}
