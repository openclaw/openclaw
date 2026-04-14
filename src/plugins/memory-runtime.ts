import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { getMemoryRuntime } from "./memory-state.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { PluginLogger } from "./types.js";

function createQuietMemoryRuntimeLogger(): PluginLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function ensureMemoryRuntime(
  cfg?: OpenClawConfig,
  options?: {
    emitTrustWarnings?: boolean;
    logger?: PluginLogger;
  },
) {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    return current;
  }
  resolveRuntimePluginRegistry(
    buildPluginRuntimeLoadOptions(
      resolvePluginRuntimeLoadContext({
        config: cfg,
        ...(options?.logger ? { logger: options.logger } : {}),
      }),
      options?.emitTrustWarnings !== undefined
        ? { emitTrustWarnings: options.emitTrustWarnings }
        : {},
    ),
  );
  return getMemoryRuntime();
}

export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}) {
  const runtime = ensureMemoryRuntime(
    params.cfg,
    params.purpose === "status"
      ? {
          emitTrustWarnings: false,
          logger: createQuietMemoryRuntimeLogger(),
        }
      : {},
  );
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
