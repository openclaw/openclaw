import { expectDefined } from "@openclaw/normalization-core";
import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadExactSessionEntryCandidates,
  loadExactSessionEntryCandidatesReadOnlyBatch,
} from "../config/sessions/session-accessor.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** Request-local, read-only views avoid rematerializing a store for each sharing lookup. */
type GatewaySessionStoreView = {
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
  capturedReadSource?: CapturedSessionEntryReadSource;
};

export type GatewaySessionStoreCache = Map<string, GatewaySessionStoreView>;

export type GatewaySessionStoreRead = {
  storePath: string;
  clone?: boolean;
  agentId?: string;
  options: {
    env?: NodeJS.ProcessEnv;
    readOnly?: boolean;
    cache?: GatewaySessionStoreCache;
    exactKeys?: readonly string[];
    projection?: SessionEntryReadScope["projection"];
    readConsistency?: SessionEntryReadScope["readConsistency"];
    readSource?: SessionEntryReadSource;
  };
  result?: Result<Record<string, SessionEntry>, unknown>;
  readSource?: SessionEntryReadSource;
  capturedReadSource?: CapturedSessionEntryReadSource;
};

/** Single-target resolution keeps its original lazy read and failure order. */
export function readGatewaySessionStore(
  read: GatewaySessionStoreRead,
): Record<string, SessionEntry> {
  if (read.result === undefined) {
    const { storePath, clone, agentId, options } = read;
    const cache = options.cache;
    const cacheKey = cache
      ? `${storePath}\u0000${agentId ?? ""}\u0000${clone === false ? "0" : "1"}\u0000${options.readOnly}\u0000${JSON.stringify(options.projection ?? "full")}\u0000${options.readConsistency ?? ""}\u0000${options.exactKeys?.join("\u0001") ?? ""}`
      : "";
    let loaded = cache?.get(cacheKey);
    if (!loaded) {
      loaded = loadGatewaySessionLookupStore(read);
      cache?.set(cacheKey, loaded);
    }
    read.result = ok(loaded.store);
    read.readSource = loaded.readSource;
    read.capturedReadSource = loaded.capturedReadSource;
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
      env: read.options.env,
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

function loadGatewaySessionLookupStore({
  storePath,
  clone,
  agentId,
  options,
}: GatewaySessionStoreRead): GatewaySessionStoreView {
  if (options.exactKeys) {
    // Borrowed listing views and probes never create stores; ordinary owned reads may.
    let readSource: SessionEntryReadSource | undefined;
    let capturedReadSource: CapturedSessionEntryReadSource | undefined;
    const target = options.readSource
      ? { readSource: options.readSource, readOnly: true as const }
      : {
          ...(agentId ? { agentId } : {}),
          storePath,
          readOnly: options.readOnly !== false || clone === false,
        };
    const entries = loadExactSessionEntryCandidates({
      ...target,
      env: options.env,
      projection: options.projection,
      sessionKeys: options.exactKeys,
      onReadSource: (source) => {
        readSource = { agentId: source.agentId, path: source.path };
        capturedReadSource = source;
      },
    });
    return {
      store: Object.fromEntries(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
      ...(readSource ? { readSource } : {}),
      ...(capturedReadSource ? { capturedReadSource } : {}),
    };
  }
  const listEntries = options.readOnly
    ? listAccessorSessionEntriesReadOnly
    : listAccessorSessionEntries;
  return {
    store: Object.fromEntries(
      listEntries({
        env: options.env,
        ...(agentId ? { agentId } : {}),
        ...(clone === false ? { clone: false } : {}),
        ...(options.projection
          ? { projection: typeof options.projection === "object" ? "full" : options.projection }
          : {}),
        ...(options.readConsistency ? { readConsistency: options.readConsistency } : {}),
        storePath,
      }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    ),
  };
}
