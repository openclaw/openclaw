import { performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SqliteSessionArtifactPreparationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryStore } from "./session-accessor.sqlite-entry-store.js";
import {
  planSessionStateDeleteIfUnreferenced,
  readReferencedSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  LifecycleArtifactCleanupInput,
  LifecycleArtifactCleanupPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely, withSqliteSessionDatabase } from "./session-accessor.sqlite-scope.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function sessionKeyBelongsToAgent(sessionKey: string, agentId: string | undefined): boolean {
  if (agentId === undefined) {
    return true;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed !== null && normalizeAgentId(parsed.agentId) === normalizeAgentId(agentId);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  sessionUpdatedAt?: number;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  if (
    params.sessionUpdatedAt !== undefined &&
    params.nowMs - params.sessionUpdatedAt < params.orphanTranscriptMinAgeMs
  ) {
    return false;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", params.sessionId),
  );
  const transcriptUpdatedAt =
    row?.updated_at === null || row?.updated_at === undefined
      ? undefined
      : sqliteNumber(row.updated_at);
  const updatedAt =
    params.sessionUpdatedAt === undefined
      ? transcriptUpdatedAt
      : Math.max(params.sessionUpdatedAt, transcriptUpdatedAt ?? params.sessionUpdatedAt);
  return updatedAt === undefined || params.nowMs - updatedAt >= params.orphanTranscriptMinAgeMs;
}

function sqliteTranscriptStateHasMarker(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  sessionId: string;
  transcriptContentMarker: string;
  diagnostics?: SqliteSessionArtifactPreparationDiagnostics;
}): boolean {
  const startedAt = params.diagnostics ? performance.now() : 0;
  if (params.diagnostics) {
    params.diagnostics.markerWindows = (params.diagnostics.markerWindows ?? 0) + 1;
  }
  try {
    const db = getSessionKysely(params.database.db);
    const rows = iterateSqliteQuerySync(
      params.database.db,
      db
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(params.database.db).as("event_json"))
        .where("session_id", "=", params.sessionId)
        .orderBy("seq", "asc"),
    );
    // Consume every row so late SQLite errors still abort cleanup planning.
    let hasMarker = false;
    for (const row of rows) {
      if (params.diagnostics) {
        params.diagnostics.markerRows = (params.diagnostics.markerRows ?? 0) + 1;
      }
      hasMarker ||= row.event_json.includes(params.transcriptContentMarker);
    }
    return hasMarker;
  } finally {
    if (params.diagnostics) {
      params.diagnostics.markerScanMs =
        (params.diagnostics.markerScanMs ?? 0) + performance.now() - startedAt;
    }
  }
}

const ORPHAN_WINDOW_PAGE_SIZE = 128;

function readOrphanWindowPage(database: OpenClawAgentReadOnlyDatabase, afterSessionId?: string) {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "plugin_owner_id"])
      .where("session_id", "not in", db.selectFrom("session_nodes").select("current_session_id"))
      .$if(afterSessionId !== undefined, (query) => query.where("session_id", ">", afterSessionId!))
      .orderBy("session_id", "asc")
      .limit(ORPHAN_WINDOW_PAGE_SIZE),
  ).rows;
}

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
function* planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  agentId?: string;
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentReadOnlyDatabase;
  firstPage: ReturnType<typeof readOrphanWindowPage>;
  excludedSessionIds?: ReadonlySet<string>;
  pluginOwnerId?: string;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
  diagnostics?: SqliteSessionArtifactPreparationDiagnostics;
}): Generator<void, SessionStateDeletePlan[]> {
  let rows = params.firstPage;
  const deletePlans: SessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a historical window that is no
  // longer the node's current id. The marker scopes cleanup to this lifecycle.
  while (rows.length > 0) {
    if (params.diagnostics) {
      params.diagnostics.windowRows = (params.diagnostics.windowRows ?? 0) + rows.length;
    }
    for (const row of rows) {
      if (
        !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
        params.referencedSessionIds.has(row.session_id) ||
        params.excludedSessionIds?.has(row.session_id) ||
        (params.pluginOwnerId &&
          row.plugin_owner_id &&
          row.plugin_owner_id !== params.pluginOwnerId)
      ) {
        continue;
      }
      if (
        !sqliteTranscriptStateIsReclaimable({
          database: params.database,
          sessionId: row.session_id,
          nowMs: params.nowMs,
          orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        }) ||
        !sqliteTranscriptStateHasMarker({
          database: params.database,
          sessionId: row.session_id,
          transcriptContentMarker: params.transcriptContentMarker,
          diagnostics: params.diagnostics,
        })
      ) {
        continue;
      }
      const plan = planSessionStateDeleteIfUnreferenced({
        archiveTranscript: params.archiveRemovedEntryTranscripts,
        archiveDirectory: params.archiveDirectory,
        database: params.database,
        reason: "deleted",
        referencedSessionIds: params.referencedSessionIds,
        sessionId: row.session_id,
      });
      if (plan) {
        deletePlans.push(plan);
      }
    }
    if (rows.length < ORPHAN_WINDOW_PAGE_SIZE) {
      break;
    }
    yield;
    rows = readOrphanWindowPage(params.database, rows.at(-1)!.session_id);
  }
  return deletePlans;
}

/** Called inside the lifecycle writer FIFO; only candidate stores need writable preparation. */
export async function prepareSessionLifecycleArtifactCleanup(
  databaseOptions: OpenClawAgentDatabaseOptions,
  params: Parameters<typeof planSessionLifecycleArtifactCleanup>[1],
): Promise<LifecycleArtifactCleanupPlan> {
  if (!getOpenClawAgentDatabaseIfOpen(databaseOptions)) {
    try {
      const plan = withOpenClawAgentDatabaseReadOnly(
        (database) => planSessionLifecycleArtifactCleanup(database, params),
        databaseOptions,
      );
      return plan.found ? plan.value : { entries: [], deletePlans: [] };
    } catch {
      // Uncertain sources retain writable admission's repair and integrity diagnosis.
    }
  }
  return withSqliteSessionDatabase(
    databaseOptions,
    (database) => planSessionLifecycleArtifactCleanup(database, params),
    undefined,
    params.diagnostics,
  );
}

export function readSessionLifecycleArtifactCleanup(
  database: OpenClawAgentReadOnlyDatabase,
  params: LifecycleArtifactCleanupInput,
  expectedSource: DatabaseFileIdentity,
): LifecycleArtifactCleanupPlan {
  assertOpenClawAgentDatabaseIdentity(database, expectedSource);
  const plan = planSessionLifecycleArtifactCleanup(database, params);
  assertOpenClawAgentDatabaseIdentity(database, expectedSource);
  return plan;
}

export function planSessionLifecycleArtifactCleanup(
  database: OpenClawAgentReadOnlyDatabase,
  params: LifecycleArtifactCleanupInput,
): LifecycleArtifactCleanupPlan {
  const pages = planSessionLifecycleArtifactCleanupPages(database, params);
  for (;;) {
    const page = readWithCanonicalSessionReaderContinuation(database, params.continuation, () =>
      runSqliteDeferredTransactionSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        return pages.next();
      }),
    );
    if (page.done) {
      return page.value;
    }
  }
}

function* planSessionLifecycleArtifactCleanupPages(
  database: OpenClawAgentReadOnlyDatabase,
  params: LifecycleArtifactCleanupInput,
): Generator<void, LifecycleArtifactCleanupPlan> {
  const diagnostics = params.diagnostics;
  type Phase = "nodeInventoryMs" | "referencePlanningMs" | "orphanPlanningMs";
  let phase: Phase = "nodeInventoryMs";
  let phaseStartedAt = diagnostics ? performance.now() : 0;
  if (diagnostics) {
    diagnostics.windowRows = 0;
    diagnostics.markerScanMs = 0;
    diagnostics.markerRows = 0;
    diagnostics.markerWindows = 0;
    diagnostics.completed = false;
  }
  const recordPhase = (next?: Phase) => {
    if (diagnostics) {
      const finishedAt = performance.now();
      diagnostics[phase] = (diagnostics[phase] ?? 0) + finishedAt - phaseStartedAt;
      phaseStartedAt = finishedAt;
    }
    if (next) {
      phase = next;
    }
  };
  try {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["session_key", "current_session_id", "updated_at"])
        .orderBy("session_key", "asc"),
    ).rows;

    if (diagnostics) {
      diagnostics.nodeRows = rows.length;
    }
    const candidates = rows.filter(
      (row) =>
        sessionKeyBelongsToAgent(row.session_key, params.agentId) &&
        sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix) &&
        sqliteTranscriptStateIsReclaimable({
          database,
          // Admission touches nodes even when a run has no new event.
          sessionUpdatedAt: sqliteNumber(row.updated_at),
          sessionId: row.current_session_id,
          nowMs: params.nowMs,
          orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        }),
    );
    const removedSessionIds = new Set<string>();
    const entries: LifecycleArtifactCleanupPlan["entries"] = [];
    const candidateEntries = readSessionEntryStore(database, {
      sessionKeys: candidates.map((row) => row.session_key),
    });
    const foreignOwnedSessionIds = params.pluginOwnerId
      ? new Set(
          executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_windows")
              .select("session_id")
              .where("plugin_owner_id", "is not", null)
              .where("plugin_owner_id", "!=", params.pluginOwnerId),
          ).rows.map((row) => row.session_id),
        )
      : undefined;
    for (const row of candidates) {
      const entry = candidateEntries[row.session_key];
      const sessionIds = uniqueStrings([
        row.current_session_id,
        ...(entry ? collectSessionStateIdsForEntry(entry) : []),
      ]);
      // Window ownership survives placeholder nodes and ownerless row projections; preserve
      // the entire node when any referenced generation belongs to another plugin.
      if (
        (params.pluginOwnerId &&
          entry?.pluginOwnerId &&
          entry.pluginOwnerId !== params.pluginOwnerId) ||
        sessionIds.some((sessionId) => foreignOwnedSessionIds?.has(sessionId))
      ) {
        continue;
      }
      for (const sessionId of sessionIds) {
        removedSessionIds.add(sessionId);
      }
      entries.push({ expectedEntry: entry, sessionKey: row.session_key });
    }

    if (diagnostics) {
      diagnostics.selectedEntries = entries.length;
    }
    const firstPage = readOrphanWindowPage(database);
    if (entries.length === 0 && firstPage.length === 0) {
      if (diagnostics) {
        diagnostics.deletePlans = 0;
        diagnostics.completed = true;
      }
      return { entries, deletePlans: [] };
    }
    recordPhase("referencePlanningMs");
    const referencedSessionIds = readReferencedSessionIds(
      database,
      new Set(entries.map((entry) => entry.sessionKey)),
    );
    if (diagnostics) {
      diagnostics.referenceIds = referencedSessionIds.size;
    }
    const deletePlans: SessionStateDeletePlan[] = [];
    for (const sessionId of removedSessionIds) {
      const plan = planSessionStateDeleteIfUnreferenced({
        archiveTranscript: params.archiveRemovedEntryTranscripts,
        archiveDirectory: params.archiveDirectory,
        database,
        referencedSessionIds,
        sessionId,
      });
      if (plan) {
        deletePlans.push(plan);
      }
    }
    recordPhase("orphanPlanningMs");
    deletePlans.push(
      ...(yield* planSqliteOrphanLifecycleTranscriptStateDeletes({
        ...(params.agentId ? { agentId: params.agentId } : {}),
        archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
        archiveDirectory: params.archiveDirectory,
        database,
        firstPage,
        excludedSessionIds: removedSessionIds,
        ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
        referencedSessionIds,
        transcriptContentMarker: params.transcriptContentMarker,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs: params.nowMs,
        diagnostics,
      })),
    );
    if (diagnostics) {
      diagnostics.deletePlans = deletePlans.length;
      diagnostics.completed = true;
    }
    return { deletePlans, entries };
  } finally {
    recordPhase();
    if (diagnostics?.orphanPlanningMs !== undefined) {
      // Marker reads have their own timer; keep the emitted planning phases disjoint.
      diagnostics.orphanPlanningMs -= diagnostics.markerScanMs ?? 0;
    }
  }
}
