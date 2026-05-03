import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { getMemoryRuntime } from "./memory-state.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";

function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const memorySlot = normalizePluginsConfig(config.plugins).slots.memory;
  return typeof memorySlot === "string" && memorySlot.trim().length > 0 ? [memorySlot] : [];
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
  // Fast path: reuse the active registry if the memory plugin is already loaded.
  // Falls back to a full load (e.g. doctor CLI, where no registry is active yet).
  if (!getLoadedRuntimePluginRegistry({ requiredPluginIds: onlyPluginIds })) {
    const context = resolvePluginRuntimeLoadContext({ config: cfg });
    resolveRuntimePluginRegistry(buildPluginRuntimeLoadOptions(context, { onlyPluginIds }));
  }
  return getMemoryRuntime();
}

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

export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}

export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}
