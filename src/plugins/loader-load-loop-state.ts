import { resolveMemorySlotDecision } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { slotOwnerRequestsMemoryBackends } from "./memory-backend.js";
import type { PluginRecord } from "./registry.js";

/** Per-load bookkeeping shared by every candidate in one plugin registry load. */
export type PluginLoadLoopState = {
  seenIds: Map<string, PluginRecord["origin"]>;
  selectedMemoryPluginId: string | null;
  memorySlotMatched: boolean;
  /** The selected slot owner's manifest asked for every enabled memory plugin as a backend. */
  memoryBackendsRequested: boolean;
  pluginLoadAttemptCount: number;
};

export function createPluginLoadLoopState(
  manifests: readonly PluginManifestRecord[],
  memorySlot: string | null | undefined,
): PluginLoadLoopState {
  return {
    seenIds: new Map(),
    selectedMemoryPluginId: null,
    memorySlotMatched: false,
    memoryBackendsRequested: slotOwnerRequestsMemoryBackends(manifests, memorySlot),
    pluginLoadAttemptCount: 0,
  };
}

/** Memory slot decision for one candidate against the plugin this load already selected. */
export function resolveLoopMemorySlotDecision(
  state: PluginLoadLoopState,
  id: string,
  slot: string | null | undefined,
  kind: PluginRecord["kind"],
) {
  return resolveMemorySlotDecision({ id, kind, slot, selectedId: state.selectedMemoryPluginId });
}
