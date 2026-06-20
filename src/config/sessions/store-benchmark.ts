import type {
  SessionStoreAdapter,
  SessionStoreListOptions,
  SessionStoreRecord,
} from "./storage-adapter.js";
import type { SessionEntry } from "./types.js";

export type SyntheticSessionStoreOptions = {
  sessionCount: number;
  agentId?: string;
  sessionKeyPrefix?: string;
  updatedAtStartMs?: number;
  updatedAtStepMs?: number;
};

export type BoundedSessionStoreReadBenchmarkOptions = {
  storePath: string;
  pageSize: number;
  maxPages?: number;
  expectedTotalCount?: number;
  readKeys?: readonly string[];
  orderBy?: SessionStoreListOptions["orderBy"];
  nowMs?: () => number;
};

export type BoundedSessionStoreReadBenchmarkResult = {
  storePath: string;
  backend: SessionStoreAdapter["kind"];
  pageSize: number;
  orderBy: NonNullable<SessionStoreListOptions["orderBy"]>;
  pages: number;
  entriesRead: number;
  totalCount: number;
  maxPageEntries: number;
  readKeys: number;
  readHits: number;
  readMisses: number;
  elapsedMs: number;
};

export class SessionStoreBenchmarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStoreBenchmarkError";
  }
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new SessionStoreBenchmarkError(`${label} must be finite`);
  }
  const normalized = Math.floor(value);
  if (normalized < 1) {
    throw new SessionStoreBenchmarkError(`${label} must be at least 1`);
  }
  return normalized;
}

function formatSyntheticSessionKey(agentId: string, index: number, prefix: string): string {
  return `agent:${agentId}:${prefix}-${String(index).padStart(6, "0")}`;
}

export function createSyntheticSessionStore(
  options: SyntheticSessionStoreOptions,
): SessionStoreRecord {
  const sessionCount = normalizePositiveInteger(options.sessionCount, "sessionCount");
  const agentId = options.agentId ?? "main";
  const prefix = options.sessionKeyPrefix ?? "synthetic";
  const updatedAtStartMs = options.updatedAtStartMs ?? 1_700_000_000_000;
  const updatedAtStepMs = options.updatedAtStepMs ?? 1_000;
  const store: SessionStoreRecord = {};
  for (let index = 0; index < sessionCount; index += 1) {
    const sessionKey = formatSyntheticSessionKey(agentId, index, prefix);
    store[sessionKey] = {
      sessionId: `session-${prefix}-${String(index).padStart(6, "0")}`,
      updatedAt: updatedAtStartMs + index * updatedAtStepMs,
      sessionStartedAt: updatedAtStartMs + index * updatedAtStepMs,
      displayName: `Synthetic session ${index}`,
    } satisfies SessionEntry;
  }
  return store;
}

export function syntheticSessionStoreKey(
  index: number,
  options: Pick<SyntheticSessionStoreOptions, "agentId" | "sessionKeyPrefix"> = {},
): string {
  return formatSyntheticSessionKey(
    options.agentId ?? "main",
    index,
    options.sessionKeyPrefix ?? "synthetic",
  );
}

export async function runBoundedSessionStoreReadBenchmark(
  adapter: SessionStoreAdapter,
  options: BoundedSessionStoreReadBenchmarkOptions,
): Promise<BoundedSessionStoreReadBenchmarkResult> {
  const pageSize = normalizePositiveInteger(options.pageSize, "pageSize");
  const maxPages = normalizePositiveInteger(options.maxPages ?? 10_000, "maxPages");
  const orderBy = options.orderBy ?? "updatedAt_desc";
  const nowMs = options.nowMs ?? Date.now;
  const startedAtMs = nowMs();
  let pages = 0;
  let offset = 0;
  let entriesRead = 0;
  let totalCount: number | undefined;
  let maxPageEntries = 0;

  for (;;) {
    if (pages >= maxPages) {
      throw new SessionStoreBenchmarkError(
        `bounded session-store benchmark exceeded maxPages=${maxPages}`,
      );
    }
    const page = await adapter.listEntries(options.storePath, {
      limit: pageSize,
      offset,
      orderBy,
    });
    if (page.entries.length > pageSize) {
      throw new SessionStoreBenchmarkError(
        `adapter returned ${page.entries.length} entries for pageSize=${pageSize}`,
      );
    }
    if (totalCount !== undefined && page.totalCount !== totalCount) {
      throw new SessionStoreBenchmarkError(
        `adapter totalCount changed from ${totalCount} to ${page.totalCount}`,
      );
    }
    totalCount = page.totalCount;
    pages += 1;
    entriesRead += page.entries.length;
    maxPageEntries = Math.max(maxPageEntries, page.entries.length);
    if (!page.hasMore) {
      if (page.nextOffset !== undefined) {
        throw new SessionStoreBenchmarkError("adapter returned nextOffset without hasMore");
      }
      break;
    }
    if (page.nextOffset === undefined || page.nextOffset <= offset) {
      throw new SessionStoreBenchmarkError("adapter pagination did not advance");
    }
    offset = page.nextOffset;
  }

  const expectedTotalCount = options.expectedTotalCount;
  if (expectedTotalCount !== undefined) {
    if (totalCount !== expectedTotalCount || entriesRead !== expectedTotalCount) {
      throw new SessionStoreBenchmarkError(
        `bounded session-store benchmark expected ${expectedTotalCount} entries but saw totalCount=${totalCount} entriesRead=${entriesRead}`,
      );
    }
  }

  let readHits = 0;
  let readMisses = 0;
  for (const readKey of options.readKeys ?? []) {
    const entry = await adapter.readEntry(options.storePath, readKey);
    if (entry) {
      readHits += 1;
    } else {
      readMisses += 1;
    }
  }

  return {
    storePath: options.storePath,
    backend: adapter.kind,
    pageSize,
    orderBy,
    pages,
    entriesRead,
    totalCount: totalCount ?? 0,
    maxPageEntries,
    readKeys: options.readKeys?.length ?? 0,
    readHits,
    readMisses,
    elapsedMs: Math.max(0, nowMs() - startedAtMs),
  };
}
