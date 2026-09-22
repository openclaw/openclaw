import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { readSessionBranchSummaries } from "./session-accessor.sqlite-branch-summaries.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readSessionTranscriptHotWatermark,
  type SessionTranscriptWatermark,
} from "./session-accessor.sqlite-transcript-watermark.js";
import type {
  SessionBranchListParams,
  SessionBranchListResult,
  SessionBranchSummary,
} from "./session-accessor.types.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";

const SESSION_BRANCH_CACHE_MAX_ENTRIES = 32;

type SessionBranchCacheEntry = SessionTranscriptWatermark & {
  branches: SessionBranchSummary[];
  identity: OpenClawAgentDatabaseIdentity;
};

export type SessionBranchSummaryReadRequest = {
  database: { agentId: string; path: string };
  databaseIdentity: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
};
export type SessionBranchSummaryReadResult =
  | ({ status: "ok"; branches: SessionBranchSummary[] } & SessionTranscriptWatermark)
  | { status: "missing-session" | "failed" };

// Host and worker isolates share this policy, each retaining only their compact derived results.
const sessionBranchCache = new Map<string, SessionBranchCacheEntry>();

function sessionBranchCacheKey(databasePath: string, sessionId: string): string {
  return `${databasePath}\0${sessionId}`;
}

function cloneSessionBranchSummaries(branches: readonly SessionBranchSummary[]) {
  return branches.map((branch) => ({ ...branch }));
}

function readCachedSessionBranchSummaries(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
  watermark: SessionTranscriptWatermark,
): SessionBranchSummary[] | undefined {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  const cached = sessionBranchCache.get(cacheKey);
  if (
    !cached ||
    cached.identity !== readOpenClawAgentDatabaseIdentity(database).identity ||
    cached.generation !== watermark.generation ||
    cached.maxSeq !== watermark.maxSeq
  ) {
    return undefined;
  }
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, cached);
  return cached.branches;
}

function cacheSessionBranchSummaries(
  database: OpenClawAgentReadOnlyDatabase,
  sessionId: string,
  snapshot: SessionTranscriptWatermark & { branches: SessionBranchSummary[] },
): void {
  const cacheKey = sessionBranchCacheKey(database.path, sessionId);
  sessionBranchCache.delete(cacheKey);
  sessionBranchCache.set(cacheKey, {
    branches: snapshot.branches,
    generation: snapshot.generation,
    maxSeq: snapshot.maxSeq,
    identity: readOpenClawAgentDatabaseIdentity(database).identity,
  });
  pruneMapToMaxSize(sessionBranchCache, SESSION_BRANCH_CACHE_MAX_ENTRIES);
}

function readSessionBranchSnapshot(
  database: OpenClawAgentReadOnlyDatabase,
  expected: Pick<
    SessionBranchSummaryReadRequest,
    "sessionKey" | "sessionId" | "lifecycleRevision"
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
      const entry = readSessionEntryRow(database, expected.sessionKey)?.entry;
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
      const cached = readCachedSessionBranchSummaries(database, expected.sessionId, watermark);
      const branches = cached ?? readSessionBranchSummaries(database, expected.sessionId);
      if (!cached) {
        cacheSessionBranchSummaries(database, expected.sessionId, { ...watermark, branches });
      }
      return { status: "ok", ...watermark, branches: cloneSessionBranchSummaries(branches) };
    },
    { operationLabel: "session branch summaries read" },
  );
}

/** The transcript worker opens and closes its own read-only handle; only summaries leave it. */
export function readSessionBranchSummariesInWorker(
  request: SessionBranchSummaryReadRequest,
): SessionBranchSummaryReadResult {
  const result = withFreshOpenClawAgentDatabaseReadOnly(
    (database) => readSessionBranchSnapshot(database, request),
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

export async function listSessionBranches(
  params: SessionBranchListParams,
): Promise<SessionBranchListResult> {
  const sourceKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  try {
    const retained = retainOpenClawAgentDatabaseReadOnly(toDatabaseOptions(resolved));
    if (!retained.found) {
      return { status: "missing-session" };
    }
    const { database, claim } = retained;
    const completion = createDeferredCore();
    const controller = new AbortController();
    let unregister = () => {};
    try {
      const selected = readSessionEntryRow(database, sourceKey)?.entry;
      if (!selected?.sessionId) {
        return { status: "missing-session" };
      }
      const expected = {
        sessionKey: sourceKey,
        sessionId: selected.sessionId,
        lifecycleRevision: selected.lifecycleRevision,
      };
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        claim.assertCurrent();
      };
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: database.agentId,
        path: database.path,
        revoke: () => controller.abort(new Error("Session branch read was revoked")),
        close: () => completion.promise,
      });
      return await readRestoredSessionTranscript(
        { ...params, agentId: resolved.agentId, sessionId: selected.sessionId },
        async (): Promise<SessionBranchListResult> => {
          assertCurrent();
          const watermark = readSessionTranscriptHotWatermark(database, selected.sessionId);
          const cached = readCachedSessionBranchSummaries(database, selected.sessionId, watermark);
          let snapshot: SessionBranchSummaryReadResult;
          if (cached) {
            snapshot = { status: "ok", ...watermark, branches: cached };
          } else if (typeof claim.identity === "symbol") {
            // Incognito transcripts live only in this process's in-memory database.
            snapshot = readSessionBranchSnapshot(database, expected);
          } else {
            const { runSessionBranchSummaryWorkerRequest } =
              await import("./session-transcript-worker-runtime.js");
            assertCurrent();
            snapshot = await runSessionBranchSummaryWorkerRequest(
              {
                database: { agentId: database.agentId, path: database.path },
                databaseIdentity: claim.identity,
                ...expected,
              },
              controller.signal,
            );
          }
          assertCurrent();
          const current = readSessionEntryRow(database, sourceKey)?.entry;
          if (
            current?.sessionId !== expected.sessionId ||
            current.lifecycleRevision !== expected.lifecycleRevision
          ) {
            return { status: "failed" };
          }
          if (snapshot.status !== "ok") {
            return snapshot;
          }
          // Keep the worker's exact watermark; an append during the read invalidates the next lookup.
          cacheSessionBranchSummaries(database, selected.sessionId, snapshot);
          return { status: "ok", branches: cloneSessionBranchSummaries(snapshot.branches) };
        },
      );
    } finally {
      try {
        claim.release();
      } finally {
        completion.resolve();
        unregister();
      }
    }
  } catch {
    return { status: "failed" };
  }
}
