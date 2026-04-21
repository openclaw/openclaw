import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { getMemoryRuntime } from "./memory-state.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { defaultSlotIdForKey } from "./slots.js";

function resolveScopedMemoryPluginIds(cfg: OpenClawConfig): string[] {
  if (cfg.plugins?.enabled === false) {
    return [];
  }
  const rawMemorySlot = normalizeOptionalString(cfg.plugins?.slots?.memory) ?? "";
  const normalizedMemorySlot = normalizeLowercaseStringOrEmpty(rawMemorySlot);
  if (normalizedMemorySlot === "none") {
    return [];
  }
  return [normalizedMemorySlot || defaultSlotIdForKey("memory")];
}

function ensureMemoryRuntime(cfg?: OpenClawConfig, purpose?: "default" | "status") {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    return current;
  }
  const context = resolvePluginRuntimeLoadContext({ config: cfg });
  const baseLoadOptions = buildPluginRuntimeLoadOptions(context);
  if (purpose === "status") {
    const scopedPluginIds = resolveScopedMemoryPluginIds(context.config);

    if (scopedPluginIds.length > 0) {
      resolveRuntimePluginRegistry({
        ...baseLoadOptions,
        onlyPluginIds: scopedPluginIds,
      });
      const scopedRuntime = getMemoryRuntime();
      if (scopedRuntime) {
        return scopedRuntime;
      }
    }
  }

  resolveRuntimePluginRegistry(baseLoadOptions);
  return getMemoryRuntime();
}

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}) {
  const runtime = ensureMemoryRuntime(params.cfg, params.purpose);
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
