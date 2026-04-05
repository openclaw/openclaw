import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginCapabilityProviders } from "./capability-provider-runtime.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  const registered = listRegisteredMemoryEmbeddingProviders();
  if (registered.length > 0) {
    return registered.map((entry) => entry.adapter);
  }
  return resolvePluginCapabilityProviders({
    key: "memoryEmbeddingProviders",
    cfg,
  });
}

export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  const registered = getRegisteredMemoryEmbeddingProvider(id);
  if (registered) {
    return registered.adapter;
  }
  if (listRegisteredMemoryEmbeddingProviders().length > 0) {
    return undefined;
  }
  return listMemoryEmbeddingProviders(cfg).find((adapter) => adapter.id === id);
}
