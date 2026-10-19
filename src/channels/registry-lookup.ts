import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ActivePluginChannelRegistration } from "../plugins/channel-registry-state.types.js";
import {
  getActivePluginChannelRegistrySnapshotFromState,
  type ActivePluginChannelRegistrySnapshot,
} from "../plugins/runtime-channel-state.js";

type RegisteredChannelPluginLookup = {
  snapshot: ActivePluginChannelRegistrySnapshot;
  entries: ActivePluginChannelRegistration[];
  byKey: Map<string, ActivePluginChannelRegistration>;
  byId: Map<string, ActivePluginChannelRegistration>;
};

let registeredChannelPluginLookup: RegisteredChannelPluginLookup | undefined;

function setLookupEntry(
  map: Map<string, ActivePluginChannelRegistration>,
  key: string | undefined,
  entry: ActivePluginChannelRegistration,
): void {
  if (key && !map.has(key)) {
    map.set(key, entry);
  }
}

function buildRegisteredChannelPluginLookup(): RegisteredChannelPluginLookup {
  const snapshot = getActivePluginChannelRegistrySnapshotFromState();
  const cached = registeredChannelPluginLookup;
  if (cached?.snapshot === snapshot) {
    return cached;
  }
  const entries = snapshot.registry?.channels ?? [];
  const byKey = new Map<string, ActivePluginChannelRegistration>();
  const byId = new Map<string, ActivePluginChannelRegistration>();
  for (const entry of entries) {
    const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "");
    setLookupEntry(byKey, id, entry);
    setLookupEntry(byId, id, entry);
  }
  // Canonical ids are registered first so aliases can never shadow them.
  for (const entry of entries) {
    for (const alias of entry.plugin.meta?.aliases ?? []) {
      setLookupEntry(byKey, normalizeOptionalLowercaseString(alias), entry);
    }
  }
  registeredChannelPluginLookup = {
    snapshot,
    entries,
    byKey,
    byId,
  };
  return registeredChannelPluginLookup;
}

export function listRegisteredChannelPluginEntries(): ActivePluginChannelRegistration[] {
  return buildRegisteredChannelPluginLookup().entries;
}

export function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): ActivePluginChannelRegistration | undefined {
  return buildRegisteredChannelPluginLookup().byKey.get(normalizedKey);
}

export function findRegisteredChannelPluginEntryById(
  id: string,
): ActivePluginChannelRegistration | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return buildRegisteredChannelPluginLookup().byId.get(normalizedId);
}
