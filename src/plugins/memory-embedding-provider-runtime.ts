import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginCapabilityProviders } from "./capability-provider-runtime.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";
import type { PluginLogger } from "./types.js";

export { listRegisteredMemoryEmbeddingProviders };

export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
  options?: {
    emitTrustWarnings?: boolean;
    logger?: PluginLogger;
  },
): MemoryEmbeddingProviderAdapter[] {
  const registered = listRegisteredMemoryEmbeddingProviderAdapters();
  if (registered.length > 0) {
    return registered;
  }
  return resolvePluginCapabilityProviders({
    key: "memoryEmbeddingProviders",
    cfg,
    ...(options?.emitTrustWarnings !== undefined
      ? { emitTrustWarnings: options.emitTrustWarnings }
      : {}),
    ...(options?.logger ? { logger: options.logger } : {}),
  });
}

export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
  options?: {
    emitTrustWarnings?: boolean;
    logger?: PluginLogger;
  },
): MemoryEmbeddingProviderAdapter | undefined {
  const registered = getRegisteredMemoryEmbeddingProvider(id);
  if (registered) {
    return registered.adapter;
  }
  if (listRegisteredMemoryEmbeddingProviders().length > 0) {
    return undefined;
  }
  return listMemoryEmbeddingProviders(cfg, options).find((adapter) => adapter.id === id);
}
