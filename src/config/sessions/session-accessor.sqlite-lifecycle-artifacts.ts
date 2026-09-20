import { performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SqliteSessionArtifactPreparationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryStore } from "./session-accessor.sqlite-entry-store.js";
import {
  collectProjectedReferencedSessionIds,
  planSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { LifecycleArtifactCleanupPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";

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

function readSessionTranscriptUpdatedAt(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): number | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === null || row?.updated_at === undefined) {
    return undefined;
  }
  return sqliteNumber(row.updated_at);
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
  const transcriptUpdatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
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
        .select("event_json")
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

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
function planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  agentId?: string;
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  excludedSessionIds?: ReadonlySet<string>;
  pluginOwnerId?: string;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
  diagnostics?: SqliteSessionArtifactPreparationDiagnostics;
}): SessionStateDeletePlan[] {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "plugin_owner_id"])
      .orderBy("session_id", "asc"),
  ).rows;

  if (params.diagnostics) {
    params.diagnostics.windowRows = rows.length;
  }
  const deletePlans: SessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a historical window that is no
  // longer the node's current id. The marker scopes cleanup to this lifecycle.
  for (const row of rows) {
    if (
      !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
      params.referencedSessionIds.has(row.session_id) ||
      params.excludedSessionIds?.has(row.session_id) ||
      (params.pluginOwnerId && row.plugin_owner_id && row.plugin_owner_id !== params.pluginOwnerId)
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
  return deletePlans;
}

/** A negative selection avoids writable admission; the planner still owns every deletion decision. */
function hasSessionLifecycleArtifactCleanupCandidates(
  database: Pick<OpenClawAgentDatabase, "db">,
  params: Parameters<typeof planSessionLifecycleArtifactCleanup>[1],
): boolean {
  const db = getSessionKysely(database.db);
  for (const row of iterateSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("session_key"),
  )) {
    if (
      sessionKeyBelongsToAgent(row.session_key, params.agentId) &&
      sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)
    ) {
      return true;
    }
  }
  const windows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "plugin_owner_id"])
      .where("session_id", "not in", db.selectFrom("session_nodes").select("current_session_id"))
      .orderBy("session_id", "asc"),
  );
  for (const row of windows) {
    if (
      !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
      (params.pluginOwnerId && row.plugin_owner_id && row.plugin_owner_id !== params.pluginOwnerId)
    ) {
      continue;
    }
    if (
      sqliteTranscriptStateIsReclaimable({
        database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      }) &&
      sqliteTranscriptStateHasMarker({
        database,
        sessionId: row.session_id,
        transcriptContentMarker: params.transcriptContentMarker,
      })
    ) {
      return true;
    }
  }
  return false;
}

/** Called inside the lifecycle writer FIFO; only candidate stores need writable preparation. */
export async function prepareSessionLifecycleArtifactCleanup(
  databaseOptions: OpenClawAgentDatabaseOptions,
  params: Parameters<typeof planSessionLifecycleArtifactCleanup>[1],
): Promise<LifecycleArtifactCleanupPlan> {
  if (!getOpenClawAgentDatabaseIfOpen(databaseOptions)) {
    try {
      const candidates = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteDeferredTransactionSync(database.db, () =>
            hasSessionLifecycleArtifactCleanupCandidates(database, params),
          ),
        databaseOptions,
      );
      if (!candidates.found || !candidates.value) {
        return { entries: [], deletePlans: [] };
      }
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

function planSessionLifecycleArtifactCleanup(
  database: OpenClawAgentDatabase,
  params: {
    agentId?: string;
    archiveRemovedEntryTranscripts: boolean;
    archiveDirectory: string;
    pluginOwnerId?: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
    diagnostics?: SqliteSessionArtifactPreparationDiagnostics;
  },
): LifecycleArtifactCleanupPlan {
  const diagnostics = params.diagnostics;
  type Phase = "nodeInventoryMs" | "referencePlanningMs" | "orphanPlanningMs";
  let phase: Phase = "nodeInventoryMs";
  let phaseStartedAt = diagnostics ? performance.now() : 0;
  if (diagnostics) {
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
    const removedSessionIds = new Set<string>();
    const entries: LifecycleArtifactCleanupPlan["entries"] = [];
    const projectedStore = readSessionEntryStore(database);
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
    for (const row of rows) {
      if (
        !sessionKeyBelongsToAgent(row.session_key, params.agentId) ||
        !sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)
      ) {
        continue;
      }
      const entry = projectedStore[row.session_key];
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
      if (
        !sqliteTranscriptStateIsReclaimable({
          database,
          // Admission updates the node even when a run has no event yet or reuses old events.
          sessionUpdatedAt: sqliteNumber(row.updated_at),
          sessionId: row.current_session_id,
          nowMs: params.nowMs,
          orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        })
      ) {
        continue;
      }
      for (const sessionId of sessionIds) {
        removedSessionIds.add(sessionId);
      }
      entries.push({
        expectedEntry: entry ? cloneSessionEntry(entry) : undefined,
        sessionKey: row.session_key,
      });
      delete projectedStore[row.session_key];
    }

    if (diagnostics) {
      diagnostics.selectedEntries = entries.length;
    }
    recordPhase("referencePlanningMs");
    const referencedSessionIds = collectProjectedReferencedSessionIds({
      database,
      excludedSessionKeys: entries.map((entry) => entry.sessionKey),
      projectedStore,
    });
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
      ...planSqliteOrphanLifecycleTranscriptStateDeletes({
        ...(params.agentId ? { agentId: params.agentId } : {}),
        archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
        archiveDirectory: params.archiveDirectory,
        database,
        excludedSessionIds: removedSessionIds,
        ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
        referencedSessionIds,
        transcriptContentMarker: params.transcriptContentMarker,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs: params.nowMs,
        diagnostics,
      }),
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
