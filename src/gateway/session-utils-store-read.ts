import { expectDefined } from "@openclaw/normalization-core";
import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadExactSessionEntryCandidates,
  loadExactSessionEntryCandidatesReadOnlyBatch,
} from "../config/sessions/session-accessor.js";
import type {
  SessionEntryListScope,
  SessionEntryReadSource,
} from "../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../config/sessions/types.js";

/**
 * Request-scoped store reuse.
 *
 * Sharing resolution runs once per listed row, and each run materialized every
 * entry of a candidate store, making `sessions.list` quadratic in entries. A
 * caller that resolves many keys against the same stores passes one cache so
 * each store is materialized once. Entries are shared across rows within that
 * request, so cached stores are read-only to their holder; the cache is never
 * process-global, so it cannot serve a later request stale rows.
 */
type GatewaySessionStoreView = {
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
};

export type GatewaySessionStoreCache = Map<string, GatewaySessionStoreView>;

export type GatewaySessionStoreRead = {
  storePath: string;
  clone?: boolean;
  agentId?: string;
  options: NonNullable<Parameters<typeof loadGatewaySessionLookupStore>[3]>;
  result?: Result<Record<string, SessionEntry>, unknown>;
  readSource?: SessionEntryReadSource;
};

/** Single-target resolution keeps its original lazy read and failure order. */
export function readGatewaySessionStore(
  read: GatewaySessionStoreRead,
): Record<string, SessionEntry> {
  if (read.result === undefined) {
    const loaded = loadGatewaySessionLookupStore(
      read.storePath,
      read.clone,
      read.agentId,
      read.options,
    );
    read.result = ok(loaded.store);
    read.readSource = loaded.readSource;
  }
  if (!read.result.ok) {
    throw read.result.error;
  }
  return read.result.value;
}

/** Populate exact logical lookups without materializing unrelated store entries. */
export function loadGatewaySessionStoreReads(reads: readonly GatewaySessionStoreRead[]): void {
  const pending = reads.filter((read) => read.result === undefined);
  const results = loadExactSessionEntryCandidatesReadOnlyBatch(
    pending.map((read) => ({
      agentId: read.agentId,
      storePath: read.storePath,
      projection: read.options.projection,
      clone: false,
      sessionKeys: expectDefined(read.options.exactKeys, "exact batch lookup keys"),
      onReadSource: (source) => {
        read.readSource = source;
      },
    })),
  );
  for (const [index, read] of pending.entries()) {
    const result = expectDefined(results[index], "exact batch lookup result");
    // Consume failures per logical target so prepared callers retain independent results.
    read.result = result.ok
      ? ok(Object.fromEntries(result.value.map(({ sessionKey, entry }) => [sessionKey, entry])))
      : result;
    if (!result.ok) {
      read.readSource = undefined;
    }
  }
}

function loadGatewaySessionLookupStore(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: {
    readOnly?: boolean;
    cache?: GatewaySessionStoreCache;
    exactKeys?: readonly string[];
    listKeys?: readonly string[];
    projection?: SessionEntryListScope["projection"];
    readConsistency?: SessionEntryListScope["readConsistency"];
    readSource?: SessionEntryReadSource;
  } = {},
): GatewaySessionStoreView {
  const cache = options.cache;
  const cacheKey = cache
    ? `${storePath}\u0000${agentId ?? ""}\u0000${clone === false ? "0" : "1"}\u0000${options.readOnly}\u0000${options.projection ?? "full"}\u0000${options.readConsistency ?? ""}\u0000${options.exactKeys?.join("\u0001") ?? ""}\u0000${options.listKeys ? JSON.stringify(options.listKeys) : ""}`
    : "";
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const loaded = loadGatewaySessionLookupStoreUncached(storePath, clone, agentId, options);
  cache?.set(cacheKey, loaded);
  return loaded;
}

function loadGatewaySessionLookupStoreUncached(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: {
    exactKeys?: readonly string[];
    listKeys?: readonly string[];
    readOnly?: boolean;
    projection?: SessionEntryListScope["projection"];
    readConsistency?: SessionEntryListScope["readConsistency"];
    readSource?: SessionEntryReadSource;
  } = {},
): GatewaySessionStoreView {
  if (options.exactKeys) {
    // Borrowed listing views and probes never create stores; ordinary owned reads may.
    let readSource: SessionEntryReadSource | undefined;
    const target = options.readSource
      ? { readSource: options.readSource, readOnly: true as const }
      : {
          ...(agentId ? { agentId } : {}),
          storePath,
          readOnly: options.readOnly !== false || clone === false,
        };
    const entries = loadExactSessionEntryCandidates({
      ...target,
      projection: options.projection,
      sessionKeys: options.exactKeys,
      onReadSource: (source) => {
        readSource = source;
      },
    });
    return {
      store: Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
      ...(readSource ? { readSource } : {}),
    };
  }
  const listEntries = options.readOnly
    ? listAccessorSessionEntriesReadOnly
    : listAccessorSessionEntries;
  return {
    store: Object.fromEntries(
      listEntries({
        ...(agentId ? { agentId } : {}),
        ...(clone === false ? { clone: false } : {}),
        ...(options.projection ? { projection: options.projection } : {}),
        ...(options.readConsistency ? { readConsistency: options.readConsistency } : {}),
        ...(options.listKeys ? { sessionKeys: options.listKeys } : {}),
        storePath,
      }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    ),
  };
}
