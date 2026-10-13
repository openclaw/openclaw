import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import {
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly-open.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import { readSessionBranchSummaries } from "./session-accessor.sqlite-branch-summaries.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  readSessionTranscriptHotWatermark,
  type SessionTranscriptWatermark,
} from "./session-accessor.sqlite-transcript-watermark-read.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type {
  SessionBranchSummaryReadResult,
  SessionBranchSummarySnapshot,
} from "./session-history-read.types.js";

export type { SessionBranchSummaryReadResult } from "./session-history-read.types.js";

const SESSION_BRANCH_CACHE_MAX_ENTRIES = 64;

type SessionBranchCacheEntry = SessionBranchSummarySnapshot & {
  identity: OpenClawAgentDatabaseIdentity;
};

export type SessionBranchSummaryReadRequest = {
  database: { agentId: string; path: string };
  databaseIdentity: string;
  validation?: OpenClawAgentDatabaseValidation;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  previous?: SessionBranchSummarySnapshot;
};
// The host retains compact summaries across read-worker retirement.
const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();

function sessionBranchCacheKey(databasePath: string, sessionId: string): string {
  return `${databasePath}\0${sessionId}`;
}

export function cloneSessionBranchSummaries(branches: readonly SessionBranchSummary[]) {
  return branches.map((branch) => ({ ...branch }));
}

export function readCachedSessionBranchSummaries(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
  watermark: SessionTranscriptWatermark,
): SessionBranchCacheEntry | undefined {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  const cached = sessionBranchCache.get(cacheKey);
  if (
    !cached ||
    cached.identity !== readOpenClawAgentDatabaseIdentity(database).identity ||
    cached.generation !== watermark.generation ||
    (cached.maxSeq !== watermark.maxSeq &&
      !(cached.maxSeq !== null && watermark.maxSeq !== null && cached.maxSeq < watermark.maxSeq))
  ) {
    return undefined;
  }
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, cached);
  return cached;
}

export function cacheSessionBranchSummaries(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
  snapshot: SessionBranchSummarySnapshot,
): void {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, {
    ...snapshot,
    identity: readOpenClawAgentDatabaseIdentity(database).identity,
  });
  pruneMapToMaxSize(sessionBranchCache, SESSION_BRANCH_CACHE_MAX_ENTRIES);
}

export function readSessionBranchSnapshot(
  database: OpenClawAgentReadOnlyDatabase,
  expected: Pick<
    SessionBranchSummaryReadRequest,
    "sessionKey" | "sessionId" | "lifecycleRevision" | "previous"
  > & {
    databaseIdentity?: string;
  },
): SessionBranchSummaryReadResult {
  return runSqliteDeferredTransactionSync<SessionBranchSummaryReadResult>(
    database.db,
    () => {
      if (
        expected.databaseIdentity !== undefined &&
        readOpenClawAgentDatabaseIdentity(database).identity !== expected.databaseIdentity
      ) {
        return { status: "failed" };
      }
      const entry = readSessionEntryRow(database, expected.sessionKey, "list")?.entry;
      if (!entry?.sessionId) {
        return { status: "missing-session" };
      }
      if (
        entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision
      ) {
        return { status: "failed" };
      }
      assertSessionTranscriptHot(database.db, expected.sessionId);
      // The watermark and rows must describe the same snapshot, even when a peer appends.
      const watermark = readSessionTranscriptHotWatermark(database, expected.sessionId);
      const previous = expected.previous;
      const cached =
        previous?.generation === watermark.generation &&
        previous.maxSeq !== null &&
        watermark.maxSeq !== null &&
        previous.maxSeq <= watermark.maxSeq
          ? previous
          : undefined;
      const summaries =
        cached?.maxSeq === watermark.maxSeq
          ? cached
          : readSessionBranchSummaries(database, expected.sessionId, cached);
      return {
        status: "ok",
        ...watermark,
        appendSafe: summaries.appendSafe,
        branches: cloneSessionBranchSummaries(summaries.branches),
      };
    },
    { operationLabel: "session branch summaries read" },
  );
}

/** The transcript worker opens and closes its own read-only handle; only summaries leave it. */
export function readSessionBranchSummariesInWorker(
  request: SessionBranchSummaryReadRequest,
): SessionBranchSummaryReadResult {
  const result = withFreshOpenClawAgentDatabaseReadOnly(
    (database) =>
      request.validation && !adoptOpenClawAgentDatabaseValidation(database, request.validation)
        ? { status: "failed" as const }
        : readSessionBranchSnapshot(database, request),
    request.database,
  );
  return result.found ? result.value : { status: "missing-session" };
}

export function invalidateSessionBranchCache(
  databasePath: string,
  sessionIds: readonly string[],
): void {
  for (const sessionId of uniqueStrings(sessionIds)) {
    sessionBranchCache.delete(sessionBranchCacheKey(databasePath, sessionId));
  }
}
