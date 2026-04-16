import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { getMemoryRuntime } from "./memory-state.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";

function ensureMemoryRuntime(params?: {
  cfg?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
}) {
  const current = getMemoryRuntime();
  if (current || !params?.cfg) {
    return current;
  }
  resolveRuntimePluginRegistry(
    buildPluginRuntimeLoadOptions(
      resolvePluginRuntimeLoadContext({
        config: params.cfg,
        ...(params.activationSourceConfig
          ? { activationSourceConfig: params.activationSourceConfig }
          : {}),
      }),
    ),
  );
  return getMemoryRuntime();
}

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}) {
  const runtime = ensureMemoryRuntime({
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
  });
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  return await runtime.getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
}

export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime({ cfg: params.cfg })?.resolveMemoryBackendConfig(params) ?? null;
}

export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}
