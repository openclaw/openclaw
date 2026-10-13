import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getEmbeddingProvider,
  getEmbeddingProviderAsync,
  listEmbeddingProviders,
  listEmbeddingProvidersAsync,
} from "./embedding-provider-runtime.js";
import { listRegisteredEmbeddingProviders } from "./embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";
import { warnPluginSdkDeprecation } from "./sdk-deprecation.js";

/** Lists registered memory embedding provider adapters without registry metadata. */
export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter);
}

/** @deprecated Prepared registries only; await listMemoryEmbeddingProvidersAsync for discovery. */
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  warnPluginSdkDeprecation({
    family: "embedding-registry-sync",
    method: "listMemoryEmbeddingProviders",
    replacement: "listMemoryEmbeddingProvidersAsync",
    compatibility: "The synchronous API requires an already prepared embedding registry.",
  });
  return listEmbeddingProviders(cfg);
}

/** @deprecated Prepared registries only; await getMemoryEmbeddingProviderAsync for discovery. */
export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  warnPluginSdkDeprecation({
    family: "embedding-registry-sync",
    method: "getMemoryEmbeddingProvider",
    replacement: "getMemoryEmbeddingProviderAsync",
    compatibility: "The synchronous API requires an already prepared embedding registry.",
  });
  return getEmbeddingProvider(id, cfg);
}

/** Lists memory embedding providers after preparing their runtime owners asynchronously. */
export async function listMemoryEmbeddingProvidersAsync(
  cfg?: OpenClawConfig,
): Promise<MemoryEmbeddingProviderAdapter[]> {
  return await listEmbeddingProvidersAsync(cfg);
}

/** Resolves one memory embedding provider without synchronous discovery. */
export async function getMemoryEmbeddingProviderAsync(
  id: string,
  cfg?: OpenClawConfig,
): Promise<MemoryEmbeddingProviderAdapter | undefined> {
  return await getEmbeddingProviderAsync(id, cfg);
}
