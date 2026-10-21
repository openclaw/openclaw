import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActivePluginChannelRegistry,
  ActivePluginChannelRegistration,
} from "../plugins/channel-registry-state.types.js";
import {
  getActivePluginChannelRegistrySnapshotFromState,
  type ActivePluginChannelRegistrySnapshot,
} from "../plugins/runtime-channel-state.js";

type RegisteredChannelPluginLookup = {
  snapshot: ActivePluginChannelRegistrySnapshot;
  currentRegistry: boolean;
  entries: ActivePluginChannelRegistration[];
  byKey: Map<string, ActivePluginChannelRegistration>;
  byId: Map<string, ActivePluginChannelRegistration>;
  byExactId: Map<string, ActivePluginChannelRegistration>;
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

export function resolveRegisteredChannelPluginLookup(
  registry?: ActivePluginChannelRegistry,
): RegisteredChannelPluginLookup {
  const snapshot = getActivePluginChannelRegistrySnapshotFromState();
  const cached = registeredChannelPluginLookup;
  const currentRegistry = registry === undefined || registry === snapshot.registry;
  if (currentRegistry && cached?.snapshot === snapshot) {
    return cached;
  }
  const selectedRegistry = registry ?? snapshot.registry;
  const entries = selectedRegistry?.channels ?? [];
  const byKey = new Map<string, ActivePluginChannelRegistration>();
  const byId = new Map<string, ActivePluginChannelRegistration>();
  const byExactId = new Map<string, ActivePluginChannelRegistration>();
  for (const entry of entries) {
    if (!byExactId.has(entry.plugin.id)) {
      byExactId.set(entry.plugin.id, entry);
    }
    const id = normalizeOptionalLowercaseString(entry.plugin.id);
    setLookupEntry(byId, id, entry);
    for (const alias of entry.plugin.meta?.aliases ?? []) {
      setLookupEntry(byKey, normalizeOptionalLowercaseString(alias), entry);
    }
  }
  // Canonical ids override aliases regardless of registration order.
  for (const [id, entry] of byId) {
    byKey.set(id, entry);
  }
  const lookup = {
    snapshot: currentRegistry ? snapshot : { registry: selectedRegistry, version: 0 },
    currentRegistry,
    entries,
    byKey,
    byId,
    byExactId,
  };
  if (currentRegistry) {
    registeredChannelPluginLookup = lookup;
  }
  return lookup;
}

export function listRegisteredChannelPluginEntries(): ActivePluginChannelRegistration[] {
  return resolveRegisteredChannelPluginLookup().entries;
}

export function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): ActivePluginChannelRegistration | undefined {
  return resolveRegisteredChannelPluginLookup().byKey.get(normalizedKey);
}

export function findRegisteredChannelPluginEntryById(
  id: string,
): ActivePluginChannelRegistration | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return resolveRegisteredChannelPluginLookup().byId.get(normalizedId);
}
