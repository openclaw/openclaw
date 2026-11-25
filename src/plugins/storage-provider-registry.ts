import type { StorageProvider } from "../storage/types.js";
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";
import type { PluginRegistry } from "./registry-types.js";

export function validateStorageProviderContract(
  provider: StorageProvider,
  declaredIds: readonly string[],
): { ok: true; id: string } | { ok: false; message: string } {
  const id = normalizeCapabilityProviderId(provider.id);
  if (!id) {
    return { ok: false, message: "storage provider registration missing valid id" };
  }
  if (id === "filesystem") {
    return { ok: false, message: 'storage provider id "filesystem" is reserved for core' };
  }
  if (typeof provider.label !== "string" || !provider.label.trim()) {
    return { ok: false, message: "storage provider registration missing label" };
  }
  if (typeof provider.open !== "function") {
    return { ok: false, message: "storage provider registration missing method: open" };
  }
  if (provider.validateSettings !== undefined && typeof provider.validateSettings !== "function") {
    return {
      ok: false,
      message: "storage provider registration validateSettings must be a function",
    };
  }
  return declaredIds.some((candidate) => normalizeCapabilityProviderId(candidate) === id)
    ? { ok: true, id }
    : { ok: false, message: `plugin must declare contracts.storageProviders for provider: ${id}` };
}

export function resolveStorageProvider(
  registry: Pick<PluginRegistry, "storageProviders">,
  providerId: string,
): StorageProvider | undefined {
  const id = normalizeCapabilityProviderId(providerId);
  return id ? registry.storageProviders.get(id)?.provider : undefined;
}
