import type { SessionEntry } from "./types.js";

export type SessionStoreBackendKind = "json" | "postgres" | (string & {});

export type SessionStoreRecord = Record<string, SessionEntry>;

export type SessionStoreOrdering = "updatedAt_desc" | "updatedAt_asc" | "key_asc";

export type SessionStoreListOptions = {
  /** Maximum rows to return. Omit for all rows; adapters should still expose totalCount/hasMore. */
  limit?: number;
  /** Zero-based row offset after filtering and ordering. */
  offset?: number;
  /** Optional exact key subset. */
  keys?: readonly string[];
  /** Optional keys to exclude before ordering/windowing. */
  excludeKeys?: readonly string[];
  /** Optional exact session label filter applied before ordering/windowing. */
  label?: string;
  /**
   * Optional store-indexed parent filter. This intentionally covers persisted
   * session entry links only; callers that need runtime subagent-run parity
   * must include or validate runtime child-run keys before relying on it.
   */
  spawnedBy?: string;
  /**
   * Optional store-indexed search over stable persisted fields. This is not a
   * substitute for gateway-level search fields that depend on runtime model
   * catalog or subagent-run state.
   */
  search?: string;
  /** Filter out entries whose updatedAt is older than this timestamp. */
  updatedAfter?: number;
  /** Stable ordering for bounded reads. Default: updatedAt_desc. */
  orderBy?: SessionStoreOrdering;
};

export type SessionStoreListResult = {
  entries: Array<[string, SessionEntry]>;
  totalCount: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number;
  hasMore: boolean;
};

export type SessionStoreMutationOptions = {
  skipMaintenance?: boolean;
  activeSessionKey?: string;
};

export type SessionStoreEntryBatch = ReadonlyArray<readonly [string, SessionEntry]>;

export type SessionTranscriptChunkPayload = {
  version: 1;
  startLine: number;
  endLine: number;
  lines: unknown[];
};

export type SessionTranscriptChunk = {
  chunkSeq: number;
  transcriptPath?: string;
  contentSha256: string;
  bytes: number;
  chunkJson: SessionTranscriptChunkPayload;
};

export type SessionTranscriptChunkOrdering = "chunkSeq_asc" | "chunkSeq_desc";

export type SessionTranscriptChunkListOptions = {
  /** Maximum chunks to return. Omit for all chunks; adapters should still expose totalCount/hasMore. */
  limit?: number;
  /** Zero-based chunk offset after filtering and ordering. */
  offset?: number;
  /** Stable ordering for bounded transcript reads. Default: chunkSeq_asc. */
  orderBy?: SessionTranscriptChunkOrdering;
  /** Optional exact transcript-path filter for migrated multi-transcript sessions. */
  transcriptPath?: string;
};

export type SessionTranscriptChunkListResult = {
  chunks: SessionTranscriptChunk[];
  totalCount: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number;
  hasMore: boolean;
};

export type SessionTranscriptChunkWriteOptions = SessionStoreMutationOptions & {
  agentId?: string;
};

export type SessionTurnRecord = {
  turnSeq: number;
  role: string;
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  startedAt?: string;
  endedAt?: string;
  metadataJson: Record<string, unknown>;
};

export type SessionTurnOrdering = "turnSeq_asc" | "turnSeq_desc";

export type SessionTurnListOptions = {
  /** Maximum turns to return. Omit for all turns; adapters should still expose totalCount/hasMore. */
  limit?: number;
  /** Zero-based turn offset after ordering. */
  offset?: number;
  /** Stable ordering for bounded turn reads. Default: turnSeq_asc. */
  orderBy?: SessionTurnOrdering;
};

export type SessionTurnListResult = {
  turns: SessionTurnRecord[];
  totalCount: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number;
  hasMore: boolean;
};

export type SessionTurnWriteOptions = SessionStoreMutationOptions & {
  agentId?: string;
};

export type SessionStoreAdapter = {
  readonly kind: SessionStoreBackendKind;
  loadStore(storePath: string): Promise<SessionStoreRecord>;
  readEntry(storePath: string, sessionKey: string): Promise<SessionEntry | undefined>;
  listEntries(
    storePath: string,
    options?: SessionStoreListOptions,
  ): Promise<SessionStoreListResult>;
  saveStore(
    storePath: string,
    store: SessionStoreRecord,
    options?: SessionStoreMutationOptions,
  ): Promise<void>;
  writeEntries?(
    storePath: string,
    entries: SessionStoreEntryBatch,
    options?: SessionStoreMutationOptions,
  ): Promise<void>;
  deleteEntries?(
    storePath: string,
    sessionKeys: readonly string[],
    options?: SessionStoreMutationOptions,
  ): Promise<void>;
  writeTranscriptChunks?(
    storePath: string,
    sessionKey: string,
    chunks: readonly SessionTranscriptChunk[],
    options?: SessionTranscriptChunkWriteOptions,
  ): Promise<void>;
  listTranscriptChunks?(
    storePath: string,
    sessionKey: string,
    options?: SessionTranscriptChunkListOptions,
  ): Promise<SessionTranscriptChunkListResult>;
  writeSessionTurns?(
    storePath: string,
    sessionKey: string,
    turns: readonly SessionTurnRecord[],
    options?: SessionTurnWriteOptions,
  ): Promise<void>;
  listSessionTurns?(
    storePath: string,
    sessionKey: string,
    options?: SessionTurnListOptions,
  ): Promise<SessionTurnListResult>;
  updateStore<T>(
    storePath: string,
    mutator: (store: SessionStoreRecord) => T | Promise<T>,
    options?: SessionStoreMutationOptions,
  ): Promise<T>;
};

export function normalizeSessionStoreListOptions(
  options: SessionStoreListOptions = {},
): Required<Pick<SessionStoreListOptions, "offset" | "orderBy">> &
  Pick<
    SessionStoreListOptions,
    "limit" | "keys" | "excludeKeys" | "label" | "spawnedBy" | "search" | "updatedAfter"
  > {
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;
  const updatedAfter =
    typeof options.updatedAfter === "number" && Number.isFinite(options.updatedAfter)
      ? options.updatedAfter
      : undefined;
  const label =
    typeof options.label === "string" && options.label.trim() ? options.label : undefined;
  const spawnedBy =
    typeof options.spawnedBy === "string" && options.spawnedBy.trim()
      ? options.spawnedBy
      : undefined;
  const search =
    typeof options.search === "string" && options.search.trim()
      ? options.search.trim().toLowerCase()
      : undefined;
  return {
    offset,
    ...(limit !== undefined ? { limit } : {}),
    ...(options.keys ? { keys: options.keys } : {}),
    ...(options.excludeKeys ? { excludeKeys: options.excludeKeys } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(spawnedBy !== undefined ? { spawnedBy } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(updatedAfter !== undefined ? { updatedAfter } : {}),
    orderBy: options.orderBy ?? "updatedAt_desc",
  };
}

export function normalizeSessionTranscriptChunkListOptions(
  options: SessionTranscriptChunkListOptions = {},
): Required<Pick<SessionTranscriptChunkListOptions, "offset" | "orderBy">> &
  Pick<SessionTranscriptChunkListOptions, "limit" | "transcriptPath"> {
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;
  const transcriptPath =
    typeof options.transcriptPath === "string" && options.transcriptPath.trim()
      ? options.transcriptPath
      : undefined;
  return {
    offset,
    ...(limit !== undefined ? { limit } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    orderBy: options.orderBy ?? "chunkSeq_asc",
  };
}

export function normalizeSessionTurnListOptions(
  options: SessionTurnListOptions = {},
): Required<Pick<SessionTurnListOptions, "offset" | "orderBy">> &
  Pick<SessionTurnListOptions, "limit"> {
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;
  return {
    offset,
    ...(limit !== undefined ? { limit } : {}),
    orderBy: options.orderBy ?? "turnSeq_asc",
  };
}

function addStoreSearchField(fields: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    fields.push(value);
  }
}

function sessionEntryMatchesStoreSearch(
  key: string,
  entry: SessionEntry,
  search: string | undefined,
): boolean {
  if (!search) {
    return true;
  }
  const fields: string[] = [];
  addStoreSearchField(fields, key);
  addStoreSearchField(fields, entry.displayName);
  addStoreSearchField(fields, entry.label);
  addStoreSearchField(fields, entry.subject);
  addStoreSearchField(fields, entry.sessionId);
  addStoreSearchField(fields, entry.modelProvider);
  addStoreSearchField(fields, entry.model);
  if (entry.modelProvider && entry.model) {
    fields.push(`${entry.modelProvider}/${entry.model}`);
  }
  return fields.some((field) => field.toLowerCase().includes(search));
}

export function listSessionStoreRecordEntries(
  store: SessionStoreRecord,
  options: SessionStoreListOptions = {},
): SessionStoreListResult {
  const normalized = normalizeSessionStoreListOptions(options);
  const requestedKeys = normalized.keys ? new Set(normalized.keys) : undefined;
  const excludedKeys = normalized.excludeKeys ? new Set(normalized.excludeKeys) : undefined;
  let entries = Object.entries(store).filter(([key, entry]) => {
    if (excludedKeys?.has(key)) {
      return false;
    }
    if (requestedKeys && !requestedKeys.has(key)) {
      return false;
    }
    if (normalized.label !== undefined && entry.label !== normalized.label) {
      return false;
    }
    if (
      normalized.spawnedBy !== undefined &&
      entry.spawnedBy !== normalized.spawnedBy &&
      entry.parentSessionKey !== normalized.spawnedBy
    ) {
      return false;
    }
    if (!sessionEntryMatchesStoreSearch(key, entry, normalized.search)) {
      return false;
    }
    if (
      normalized.updatedAfter !== undefined &&
      typeof entry.updatedAt === "number" &&
      entry.updatedAt < normalized.updatedAfter
    ) {
      return false;
    }
    return true;
  });

  entries = entries.toSorted(([leftKey, leftEntry], [rightKey, rightEntry]) => {
    if (normalized.orderBy === "key_asc") {
      return leftKey.localeCompare(rightKey);
    }
    const leftUpdatedAt = leftEntry.updatedAt ?? 0;
    const rightUpdatedAt = rightEntry.updatedAt ?? 0;
    const byUpdatedAt =
      normalized.orderBy === "updatedAt_asc"
        ? leftUpdatedAt - rightUpdatedAt
        : rightUpdatedAt - leftUpdatedAt;
    return byUpdatedAt || leftKey.localeCompare(rightKey);
  });

  const totalCount = entries.length;
  const start = normalized.offset;
  const end = normalized.limit === undefined ? undefined : start + normalized.limit;
  const page = entries.slice(start, end);
  const nextOffset =
    normalized.limit !== undefined && start + normalized.limit < totalCount
      ? start + normalized.limit
      : undefined;
  return {
    entries: page,
    totalCount,
    ...(normalized.limit !== undefined ? { limitApplied: normalized.limit } : {}),
    ...(start > 0 ? { offset: start } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    hasMore: nextOffset !== undefined,
  };
}
