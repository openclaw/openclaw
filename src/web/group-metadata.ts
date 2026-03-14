import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/channels/whatsapp").child("group-metadata");

export type GroupMetadataEntry = {
  subject: string;
  isCommunity: boolean;
  linkedParent?: string;
};

export type GroupMetadataProvider = {
  groupFetchAllParticipating: () => Promise<
    Record<string, { subject?: string; isCommunity?: boolean; linkedParent?: string }>
  >;
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let provider: GroupMetadataProvider | null = null;
let cache: Map<string, GroupMetadataEntry> | null = null;
let cacheTimestamp = 0;

export function setGroupMetadataProvider(p: GroupMetadataProvider): void {
  provider = p;
  cache = null;
  cacheTimestamp = 0;
  log.debug("Group metadata provider registered");
}

export function clearGroupMetadataProvider(): void {
  provider = null;
  cache = null;
  cacheTimestamp = 0;
  log.debug("Group metadata provider cleared");
}

async function fetchAndCache(): Promise<Map<string, GroupMetadataEntry>> {
  if (!provider) {
    return new Map();
  }
  try {
    const raw = await provider.groupFetchAllParticipating();
    const map = new Map<string, GroupMetadataEntry>();
    for (const [jid, meta] of Object.entries(raw)) {
      map.set(jid, {
        subject: meta.subject ?? jid,
        isCommunity: meta.isCommunity === true,
        linkedParent: meta.linkedParent ?? undefined,
      });
    }
    cache = map;
    cacheTimestamp = Date.now();
    log.debug(`Cached metadata for ${map.size} groups`);
    return map;
  } catch (err) {
    log.warn(`Failed to fetch group metadata: ${String(err)}`);
    return cache ?? new Map();
  }
}

function isCacheStale(): boolean {
  return !cache || Date.now() - cacheTimestamp > CACHE_TTL_MS;
}

export async function listGroups(): Promise<Map<string, GroupMetadataEntry>> {
  if (isCacheStale()) {
    return await fetchAndCache();
  }
  return cache!;
}

export async function getGroupMetadata(jid: string): Promise<GroupMetadataEntry | null> {
  const groups = await listGroups();
  return groups.get(jid) ?? null;
}

export async function searchGroups(query: string): Promise<Map<string, GroupMetadataEntry>> {
  const groups = await listGroups();
  const lower = query.toLowerCase();
  const results = new Map<string, GroupMetadataEntry>();
  for (const [jid, meta] of groups) {
    if (meta.subject.toLowerCase().includes(lower) || jid.toLowerCase().includes(lower)) {
      results.set(jid, meta);
    }
  }
  return results;
}
