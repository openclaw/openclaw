import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getRuntimeEmbeddingProviderAdapter,
  listRuntimeEmbeddingProviderAdapters,
  readConfiguredProviderApiId,
  resolveRuntimeEmbeddingProviderLookupIds,
} from "./embedding-provider-runtime-shared.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

export { listRegisteredMemoryEmbeddingProviders };

/** Returns registered memory embedding adapters without registry metadata. */
export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}

/**
 * Lists memory embedding providers after applying runtime config filters.
 *
 * This is the memory-specific compatibility surface over the generic embedding
 * provider runtime lookup, so legacy memory providers and newer generic
 * embedding providers can share selection behavior.
 */
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  return listRuntimeEmbeddingProviderAdapters({
    key: "memoryEmbeddingProviders",
    cfg,
    registered: listRegisteredMemoryEmbeddingProviderAdapters(),
  });
}

function resolveConfiguredMemoryEmbeddingProviderId(
  providerId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  // Provider config can alias a configured provider id to an API id. Use that
  // alias as a secondary lookup key so memory configs can target provider
  // families without duplicating every adapter id.
  return readConfiguredProviderApiId({ providerId, cfg });
}

function resolveMemoryEmbeddingProviderLookupIds(id: string, cfg?: OpenClawConfig): string[] {
  return resolveRuntimeEmbeddingProviderLookupIds({
    id,
    cfg,
    resolveConfiguredProviderId: resolveConfiguredMemoryEmbeddingProviderId,
  });
}

/** Resolves a memory embedding provider by id or configured provider API alias. */
export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  return getRuntimeEmbeddingProviderAdapter({
    key: "memoryEmbeddingProviders",
    cfg,
    lookupIds: resolveMemoryEmbeddingProviderLookupIds(id, cfg),
    getRegisteredProvider: getRegisteredMemoryEmbeddingProvider,
  });
}
