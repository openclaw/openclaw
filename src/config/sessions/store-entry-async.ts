import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  type SessionStoreAdapter,
  type SessionStoreMutationOptions,
  type SessionStoreRecord,
} from "./storage-adapter.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export type AsyncSessionStoreEntryResolution = {
  normalizedKey: string;
  existingKey?: string;
  existing?: SessionEntry;
  legacyKeys: string[];
};

export type PatchSessionStoreEntryAsyncParams = {
  adapter: SessionStoreAdapter;
  storePath: string;
  sessionKey: string;
  fallbackEntry?: SessionEntry;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  options?: SessionStoreMutationOptions;
};

export type UpsertSessionStoreEntryAsyncParams = {
  adapter: SessionStoreAdapter;
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
  allowDropAcpMeta?: boolean;
  options?: SessionStoreMutationOptions;
};

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry) as SessionEntry;
}

function uniqueCandidateKeys(sessionKey: string): string[] {
  const trimmedKey = sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalizedKey);
  return [...new Set([trimmedKey, normalizedKey, foldedLegacyKey].filter(Boolean))];
}

function updatedAt(entry: SessionEntry | undefined): number {
  return typeof entry?.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

function resolveBestCandidate(params: {
  sessionKey: string;
  entries: Array<[string, SessionEntry]>;
}): AsyncSessionStoreEntryResolution {
  const normalizedKey = normalizeStoreSessionKey(params.sessionKey.trim());
  let existingKey: string | undefined;
  let existing: SessionEntry | undefined;
  const legacyKeySet = new Set<string>();

  for (const [candidateKey, candidateEntry] of params.entries) {
    if (candidateKey !== normalizedKey) {
      legacyKeySet.add(candidateKey);
    }
    if (!existing || updatedAt(candidateEntry) > updatedAt(existing)) {
      existingKey = candidateKey;
      existing = candidateEntry;
    }
  }

  return {
    normalizedKey,
    ...(existingKey !== undefined ? { existingKey } : {}),
    ...(existing !== undefined ? { existing: cloneSessionEntry(existing) } : {}),
    legacyKeys: [...legacyKeySet],
  };
}

export async function resolveSessionStoreEntryAsync(params: {
  adapter: SessionStoreAdapter;
  storePath: string;
  sessionKey: string;
}): Promise<AsyncSessionStoreEntryResolution> {
  const candidateKeys = uniqueCandidateKeys(params.sessionKey);
  if (candidateKeys.length === 0) {
    return { normalizedKey: "", legacyKeys: [] };
  }
  const page = await params.adapter.listEntries(params.storePath, {
    keys: candidateKeys,
    limit: candidateKeys.length,
    orderBy: "updatedAt_desc",
  });
  return resolveBestCandidate({ sessionKey: params.sessionKey, entries: page.entries });
}

async function writeEntryWithLegacyCleanup(params: {
  adapter: SessionStoreAdapter;
  storePath: string;
  normalizedKey: string;
  legacyKeys: readonly string[];
  entry: SessionEntry;
  options?: SessionStoreMutationOptions;
}): Promise<void> {
  const cloned = cloneSessionEntry(params.entry);
  if (params.adapter.writeEntries && params.adapter.deleteEntries) {
    await params.adapter.writeEntries(
      params.storePath,
      [[params.normalizedKey, cloned]],
      params.options,
    );
    if (params.legacyKeys.length > 0) {
      await params.adapter.deleteEntries(params.storePath, params.legacyKeys, params.options);
    }
    return;
  }
  await params.adapter.updateStore(
    params.storePath,
    (store) => {
      store[params.normalizedKey] = cloned;
      for (const legacyKey of params.legacyKeys) {
        delete store[legacyKey];
      }
    },
    params.options,
  );
}

export async function patchSessionStoreEntryAsync(
  params: PatchSessionStoreEntryAsyncParams,
): Promise<SessionEntry | null> {
  const resolved = await resolveSessionStoreEntryAsync(params);
  const existing = resolved.existing ?? params.fallbackEntry;
  if (!existing) {
    return null;
  }
  const patch = await params.update(cloneSessionEntry(existing));
  if (!patch) {
    return existing;
  }
  const next = params.replaceEntry
    ? cloneSessionEntry(patch as SessionEntry)
    : params.preserveActivity
      ? mergeSessionEntryPreserveActivity(existing, patch)
      : mergeSessionEntry(existing, patch);
  await writeEntryWithLegacyCleanup({
    adapter: params.adapter,
    storePath: params.storePath,
    normalizedKey: resolved.normalizedKey,
    legacyKeys: resolved.legacyKeys,
    entry: next,
    options: params.options,
  });
  return cloneSessionEntry(next);
}

export async function upsertSessionStoreEntryAsync(
  params: UpsertSessionStoreEntryAsyncParams,
): Promise<void> {
  const resolved = await resolveSessionStoreEntryAsync(params);
  const next = cloneSessionEntry(params.entry);
  if (!params.allowDropAcpMeta && resolved.existing?.acp && !next.acp) {
    next.acp = resolved.existing.acp;
  }
  await writeEntryWithLegacyCleanup({
    adapter: params.adapter,
    storePath: params.storePath,
    normalizedKey: resolved.normalizedKey,
    legacyKeys: resolved.legacyKeys,
    entry: next,
    options: params.options,
  });
}

export function resolveSessionStoreEntryFromRecordForAsyncFallback(params: {
  store: SessionStoreRecord;
  sessionKey: string;
}): AsyncSessionStoreEntryResolution {
  const resolved = resolveSessionStoreEntry(params);
  return {
    normalizedKey: resolved.normalizedKey,
    ...(resolved.existing !== undefined ? { existing: cloneSessionEntry(resolved.existing) } : {}),
    legacyKeys: resolved.legacyKeys,
  };
}
