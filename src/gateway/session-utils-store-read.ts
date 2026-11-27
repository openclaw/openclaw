import {
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadExactSessionEntryCandidates,
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

/** Session keys are data; ordinary objects retain a V8 shape transition per key. */
export function createGatewaySessionStore(
  entries: readonly { sessionKey: string; entry: SessionEntry }[],
): Record<string, SessionEntry> {
  const store: Record<string, SessionEntry> = Object.create(null);
  for (const { sessionKey, entry } of entries) {
    store[sessionKey] = entry;
  }
  return store;
}

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
  result?: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
  capturedReadSource?: CapturedSessionEntryReadSource;
};

export function gatewaySessionStoreReadOptions(
  params: Pick<GatewaySessionStoreRead["options"], "env" | "projection" | "readConsistency"> & {
    exactRead?: boolean;
    preserveQualifiedAddress?: boolean;
    storeCache?: GatewaySessionStoreCache;
  },
  keys: string[],
  readOnly: boolean | undefined,
): GatewaySessionStoreRead["options"] {
  return {
    env: params.env,
    readOnly,
    ...(params.exactRead || params.preserveQualifiedAddress ? { exactKeys: keys } : {}),
    ...(params.projection ? { projection: params.projection } : {}),
    ...(params.readConsistency ? { readConsistency: params.readConsistency } : {}),
    ...(params.storeCache ? { cache: params.storeCache } : {}),
  };
}

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
    read.result = loaded.store;
    read.readSource = loaded.readSource;
    read.capturedReadSource = loaded.capturedReadSource;
  }
  return read.result;
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
      store: createGatewaySessionStore(entries),
      ...(readSource ? { readSource } : {}),
      ...(capturedReadSource ? { capturedReadSource } : {}),
    };
  }
  const listEntries = options.readOnly
    ? listAccessorSessionEntriesReadOnly
    : listAccessorSessionEntries;
  return {
    store: createGatewaySessionStore(
      listEntries({
        env: options.env,
        ...(agentId ? { agentId } : {}),
        ...(clone === false ? { clone: false } : {}),
        ...(options.projection
          ? { projection: typeof options.projection === "object" ? "full" : options.projection }
          : {}),
        ...(options.readConsistency ? { readConsistency: options.readConsistency } : {}),
        storePath,
      }),
    ),
  };
}
