import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginCapabilityProviders } from "./capability-provider-runtime.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

export { listRegisteredMemoryEmbeddingProviders };

export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  const registered = listRegisteredMemoryEmbeddingProviderAdapters();
  // Always consult the capability registry so that capability-only providers
  // (e.g. ollama) remain discoverable even when other providers are directly
  // registered.  Registered adapters take precedence for duplicate ids.
  const capability = resolvePluginCapabilityProviders({
    key: "memoryEmbeddingProviders",
    cfg,
  });
  const registeredIds = new Set(registered.map((a) => a.id));
  return [...registered, ...capability.filter((a) => !registeredIds.has(a.id))];
}

export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  const registered = getRegisteredMemoryEmbeddingProvider(id);
  if (registered) {
    return registered.adapter;
  }
  // Fall back to plugin capability resolution.  Even when other providers are
  // already registered the requested `id` may belong to a plugin that was not
  // loaded into the main registry (e.g. the ollama plugin when it is not
  // included in `plugins.allow`).  Skipping this fallback caused the
  // "Unknown memory embedding provider: ollama" error reported in #63429.
  return resolvePluginCapabilityProviders({ key: "memoryEmbeddingProviders", cfg }).find(
    (adapter) => adapter.id === id,
  );
}
