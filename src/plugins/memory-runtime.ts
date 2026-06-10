// Runtime bridge for plugin-owned memory hooks and state.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { restoreCachedMemoryPromptState } from "./loader.js";
import { getMemoryCapabilityRegistration, getMemoryRuntime } from "./memory-state.js";
import { getActivePluginRuntimeSubagentMode } from "./runtime.js";
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

type MemoryRuntimeLoadOptions = Parameters<
  typeof ensureStandaloneRuntimePluginRegistryLoaded
>[0]["loadOptions"];

function buildMemoryRuntimeLoadOptions(params: {
  cfg: OpenClawConfig;
  pluginIds: string[];
  workspaceDir: string | undefined;
}): MemoryRuntimeLoadOptions {
  const gatewayBindable = getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  return {
    config: params.cfg,
    onlyPluginIds: params.pluginIds,
    workspaceDir: params.workspaceDir,
    ...(gatewayBindable
      ? {
          runtimeOptions: { allowGatewaySubagentBinding: true as const },
          preferBuiltPluginArtifacts: true,
        }
      : {}),
  };
}

function getSelectedMemoryPromptCapability(memoryPluginIds: readonly string[]) {
  const current = getMemoryCapabilityRegistration();
  if (!current?.capability.promptBuilder || !memoryPluginIds.includes(current.pluginId)) {
    return undefined;
  }
  return current;
}

/** Ensures the configured memory plugin's prompt capability is registered. */
export function ensureActiveMemoryCapability(params: { cfg?: OpenClawConfig; pluginId?: string }) {
  if (!params.cfg) {
    return undefined;
  }
  const memoryPluginIds = resolveMemoryRuntimePluginIds(params.cfg);
  if (memoryPluginIds.length === 0) {
    return undefined;
  }
  if (params.pluginId && !memoryPluginIds.includes(params.pluginId)) {
    return undefined;
  }
  const selectedCapability = getSelectedMemoryPromptCapability(memoryPluginIds);
  if (selectedCapability) {
    return selectedCapability;
  }
  const loadedRegistry = getLoadedRuntimePluginRegistry({ requiredPluginIds: memoryPluginIds });
  const loadedCapability = getSelectedMemoryPromptCapability(memoryPluginIds);
  if (loadedCapability) {
    return loadedCapability;
  }
  if (!loadedRegistry) {
    return undefined;
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(params.cfg);
  restoreCachedMemoryPromptState({
    ...buildMemoryRuntimeLoadOptions({
      cfg: params.cfg,
      pluginIds: memoryPluginIds,
      workspaceDir,
    }),
  });
  return getSelectedMemoryPromptCapability(memoryPluginIds);
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
    loadOptions: buildMemoryRuntimeLoadOptions({
      cfg,
      pluginIds: onlyPluginIds,
      workspaceDir,
    }),
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

/** Closes the plugin-backed memory search manager for one agent. */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const runtime = getMemoryRuntime();
  await runtime?.closeMemorySearchManager?.(params);
}
