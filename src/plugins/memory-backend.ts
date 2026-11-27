import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginRegistrationMode } from "./plugin-registration.types.js";
import { hasKind } from "./slots.js";

type MemoryBackendEntry = { enabled?: boolean; memoryBackend?: boolean } | undefined;
type MemoryBackendManifest = {
  id: string;
  kind?: PluginKind | PluginKind[];
  memoryBackends?: boolean;
};

/**
 * Whether the selected slot owner's manifest asks for every enabled memory plugin as a
 * passive backend (`memoryBackends: true`). Installing such an owner is the opt-in.
 */
export function slotOwnerRequestsMemoryBackends(
  manifests: readonly MemoryBackendManifest[],
  memorySlot: string | null | undefined,
): boolean {
  if (typeof memorySlot !== "string") {
    return false;
  }
  return manifests.some(
    (manifest) => manifest.id === memorySlot && manifest.memoryBackends === true,
  );
}

/**
 * Per-plugin backend choice: an explicit `memoryBackend` entry setting wins; otherwise the
 * plugin joins only when the slot owner requested backends.
 */
function wantsBackend(entry: MemoryBackendEntry, ownerRequestsBackends: boolean): boolean {
  if (entry?.enabled === false || entry?.memoryBackend === false) {
    return false;
  }
  return entry?.memoryBackend === true || ownerRequestsBackends;
}

/**
 * Whether a memory plugin that does not own the slot loads as a passive backend instead of
 * being disabled. Slot "none" has no owner to serve, and only loads that register memory
 * capabilities for the owner qualify.
 */
export function isMemoryBackendRequested(
  entry: MemoryBackendEntry,
  memorySlot: string | null | undefined,
  pluginId: string,
  mode: PluginRegistrationMode,
  ownerRequestsBackends = false,
): boolean {
  return (
    wantsBackend(entry, ownerRequestsBackends) &&
    typeof memorySlot === "string" &&
    memorySlot !== pluginId &&
    (mode === "full" || mode === "discovery")
  );
}

/**
 * Policy ids of plugins that should load as backends beside `ownerId`: explicit
 * `memoryBackend: true` entries, plus every installed memory-kind plugin when the owner's
 * manifest requests backends. Denied, disabled, and not-allowlisted plugins never qualify.
 */
export function resolveMemoryBackendPolicyIds(params: {
  ownerId: string;
  entries: Readonly<Record<string, MemoryBackendEntry>>;
  allow: readonly string[];
  deny: readonly string[];
  manifests: readonly MemoryBackendManifest[];
  normalizeId: (id: string) => string;
}): string[] {
  const ownerPolicyId = params.normalizeId(params.ownerId);
  const ownerRequestsBackends = params.manifests.some(
    (manifest) =>
      params.normalizeId(manifest.id) === ownerPolicyId && manifest.memoryBackends === true,
  );
  const candidates = new Set(Object.keys(params.entries).map(params.normalizeId));
  if (ownerRequestsBackends) {
    for (const manifest of params.manifests) {
      if (hasKind(manifest.kind, "memory")) {
        candidates.add(params.normalizeId(manifest.id));
      }
    }
  }
  return [...candidates].filter(
    (id) =>
      id !== ownerPolicyId &&
      !params.deny.includes(id) &&
      (params.allow.length === 0 || params.allow.includes(id)) &&
      wantsBackend(params.entries[id], ownerRequestsBackends),
  );
}
