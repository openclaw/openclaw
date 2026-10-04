// Cached lookup view for active channel plugin registry entries and aliases.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type {
  ActivePluginChannelRegistration,
  ActivePluginChannelRegistry,
} from "../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistrySnapshotFromState } from "../plugins/runtime-channel-state.js";

type RegisteredChannelPluginLookup = {
  registry: ActivePluginChannelRegistry | null;
  channels: ActivePluginChannelRegistration[] | undefined;
  channelCount: number;
  version: number;
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
  const { registry, version } = getActivePluginChannelRegistrySnapshotFromState();
  const channels = Array.isArray(registry?.channels) ? registry.channels : undefined;
  const channelCount = channels?.length ?? 0;
  const cached = registeredChannelPluginLookup;
  if (
    cached &&
    cached.registry === registry &&
    cached.channels === channels &&
    cached.channelCount === channelCount &&
    cached.version === version
  ) {
    return cached;
  }
  const entries = channels?.length ? channels : [];
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
    registry,
    channels,
    channelCount,
    version,
    entries,
    byKey,
    byId,
  };
  return registeredChannelPluginLookup;
}

export function listRegisteredChannelPluginEntries(): ActivePluginChannelRegistration[] {
  return buildRegisteredChannelPluginLookup().entries;
}

/** Finds an active channel plugin registration by normalized id or alias. */
export function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): ActivePluginChannelRegistration | undefined {
  return buildRegisteredChannelPluginLookup().byKey.get(normalizedKey);
}

/** Finds an active channel plugin registration by its canonical plugin id. */
export function findRegisteredChannelPluginEntryById(
  id: string,
): ActivePluginChannelRegistration | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return buildRegisteredChannelPluginLookup().byId.get(normalizedId);
}
