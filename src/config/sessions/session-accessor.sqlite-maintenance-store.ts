import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import { prepareExactSessionEntryRowReads } from "./session-accessor.sqlite-entry-read.js";
import {
  readSessionEntryCount,
  writeArchivedSessionEntries,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
  invalidateSessionEntryMaintenanceAgeFact,
  readSessionEntryMaintenanceAgeFact,
  recordSessionEntryMaintenanceAgeFact,
  stageSessionEntryMaintenanceAgeFact,
  type SessionMaintenanceAgeContinuation,
} from "./session-accessor.sqlite-maintenance-age.js";
import {
  collectSqliteSessionMaintenanceBaseKeys,
  readSessionMaintenanceAgeCandidates,
  readSessionMaintenanceCapCandidates,
  readSessionMaintenanceKeyProjection,
} from "./session-accessor.sqlite-maintenance-candidates.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import {
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { readTranscriptContextVersionsInTransaction } from "./session-transcript-context-versions.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { planSessionEntryMaintenance } from "./store-maintenance-plan.js";
import { resolveSessionMaintenancePreserveKeys } from "./store-maintenance-preserve-snapshot.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
import { shouldRunModelRunPrune, shouldRunSessionEntryMaintenance } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export function readSessionTranscriptJsonlBytesInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): Map<string, number> {
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select([
        "session_id",
        /* kysely-allow-raw: exact JSONL bytes bound maintenance worker batches. */
        sql<number | bigint>`CAST(SUM(${transcriptEventReadBytesSql()} + 1) AS BIGINT)`.as(
          "jsonl_bytes",
        ),
      ])
      .where("session_id", "in", sessionIds)
      .groupBy("session_id"),
  ).rows;
  return new Map(rows.map((row) => [row.session_id, sqliteNumber(row.jsonl_bytes)]));
}

export function refreshSessionPlannerStatisticsInDatabase(database: OpenClawAgentDatabase): void {
  if (isPostgresSqlConnection(database.db)) {
    // PostgreSQL's server owns planner statistics and native page maintenance.
    return;
  }
  // SAFETY: SQLite returns this fixed numeric column for PRAGMA analysis_limit.
  const row = database.db.prepare("PRAGMA analysis_limit").get() as
    | { analysis_limit?: unknown }
    | undefined;
  const previousLimit = Number(row?.analysis_limit ?? 0);
  try {
    // SQLite 3.44 optimize reacts to growth; known deletions require direct analysis.
    database.db.exec("PRAGMA analysis_limit = 1000; ANALYZE main;");
  } finally {
    database.db.exec(`PRAGMA analysis_limit = ${previousLimit};`);
  }
}

export function emptySessionEntryMaintenancePlan(): SessionEntryMaintenancePlan {
  return {
    archivedEntries: [],
    entryRemovals: [],
    stateDeletePlans: [],
    archived: 0,
    capArchived: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
}

/** Inline callers already hold their transaction; workers prepare before the write transaction. */
export function applySessionEntryMaintenanceInDatabase(
  database: OpenClawAgentDatabase,
  params: Omit<SessionEntryMaintenanceInput, "preservation">,
  readPreservation: () => SessionMaintenancePreservationSnapshot,
  onArchived?: (sessionKey: string, previous: SessionEntry, current: SessionEntry) => void,
  refreshCandidates?: (sessionKeys: readonly string[]) => SessionMaintenancePreservationSnapshot,
  postimages?: SessionEntryWritePostimages,
): SessionEntryMaintenancePlan {
  let preservation: SessionMaintenancePreservationSnapshot | undefined;
  const prepared = prepareSessionEntryMaintenanceInDatabase(
    database,
    params,
    () => (preservation ??= readPreservation()),
    refreshCandidates,
  );
  return prepared(database, onArchived, postimages);
}

type SessionEntryMaintenanceApply = (
  database: OpenClawAgentDatabase,
  onArchived?: Parameters<typeof applySessionEntryMaintenanceInDatabase>[3],
  postimages?: SessionEntryWritePostimages,
) => SessionEntryMaintenancePlan;

/** Prepare before the write transaction; compare selected rows and protection dependencies inside it. */
export function prepareSessionEntryMaintenanceInDatabase(
  reader: Pick<OpenClawAgentDatabase, "db">,
  params: Omit<SessionEntryMaintenanceInput, "preservation">,
  readPreservation: () => SessionMaintenancePreservationSnapshot,
  refreshCandidates?: (sessionKeys: readonly string[]) => SessionMaintenancePreservationSnapshot,
): SessionEntryMaintenanceApply {
  const maintenance = params.maintenance;
  if (maintenance.mode === "warn") {
    return emptySessionEntryMaintenancePlan;
  }

  // Key projections and indexed age candidates keep unrelated entry payloads out
  // of automatic maintenance. Exact full entries load only for rows selected to change.
  const entryCount = readSessionEntryCount(reader, { includeArchived: false });
  const retainedAgeFact = readSessionEntryMaintenanceAgeFact(reader.db, maintenance);
  if (
    !params.forceMaintenance &&
    !params.ageContinuation &&
    retainedAgeFact &&
    Date.now() < retainedAgeFact.next.at &&
    !shouldRunSessionEntryMaintenance({ entryCount, maxEntries: maintenance.maxEntries })
  ) {
    return (database) => {
      stageSessionEntryMaintenanceAgeFact(database.db, { ...retainedAgeFact, entryCount });
      return emptySessionEntryMaintenancePlan();
    };
  }
  invalidateSessionEntryMaintenanceAgeFact(reader.db);
  const plannedAt = params.ageContinuation?.at ?? Date.now();
  const activeSessionKeys = uniqueStrings([
    params.activeSessionKey ?? "",
    ...(params.activeSessionKeys ?? []),
  ]);
  const removalReasons = new Map<
    string,
    NonNullable<SessionEntryMaintenancePlan["entryRemovals"][number]["maintenanceReason"]>
  >();
  const archivedKeys = new Set<string>();
  let durableNoCandidates = false;
  let ageContinuation: SessionMaintenanceAgeContinuation | undefined;
  const modelRunPrune =
    params.ageContinuation?.modelRunPrune ??
    shouldRunModelRunPrune({
      maintenance,
      entryCount,
      force: params.forceMaintenance,
    });
  let preserveKeys: ReadonlySet<string> | undefined;
  let baseKeys: string[] = [];
  const readPreserveKeys = () => {
    if (!preserveKeys) {
      const snapshot = readPreservation();
      const keyProjection =
        snapshot.workIdentities.length > 0 || snapshot.lifecycleIdentities.length > 0
          ? readSessionMaintenanceKeyProjection(reader)
          : undefined;
      baseKeys = collectSqliteSessionMaintenanceBaseKeys(
        (keys) => keyProjection ?? readSessionMaintenanceKeyProjection(reader, keys),
        activeSessionKeys,
      );
      preserveKeys = resolveSessionMaintenancePreserveKeys({
        snapshot,
        store: keyProjection ?? {},
        baseKeys,
      });
    }
    return preserveKeys;
  };
  const { store, archived, capArchived, modelRunPruned, pruned, capped } =
    planSessionEntryMaintenance({
      maintenance,
      initialUnarchivedCount: entryCount,
      forceMaintenance: params.forceMaintenance,
      modelRunPrune,
      nowMs: plannedAt,
      readPreserveKeys,
      log: false,
      readAgeCandidates: (minimumAgeMs, modelRunPruneAfterMs) => {
        const candidates = readSessionMaintenanceAgeCandidates({
          database: reader,
          minimumAgeMs,
          pruneAfterMs: maintenance.pruneAfterMs,
          archiveDashboardAfterMs: maintenance.archiveDashboardAfterMs,
          modelRunPruneAfterMs,
          limit: params.maxAgeEntries,
          nowMs: plannedAt,
          after: params.ageContinuation?.after,
        });
        if (params.maxAgeEntries !== undefined && candidates.last) {
          ageContinuation = { at: plannedAt, after: candidates.last, modelRunPrune };
        }
        return candidates.store;
      },
      readCapCandidates: (remainingEntryCount) => {
        // Exhaust age policy first: capping between pages can evict a different set.
        if (ageContinuation) {
          return undefined;
        }
        const overflow = Math.min(
          Math.max(0, remainingEntryCount - maintenance.maxEntries),
          params.maxCapEntries ?? Infinity,
        );
        if (overflow > 0) {
          const candidates = readSessionMaintenanceCapCandidates({
            database: reader,
            activeSessionKeys,
            overflow,
            readPreserveKeys,
            preserveRecentMs: maintenance.preserveRecentMs,
            nowMs: plannedAt,
            excludedKeys: new Set([...removalReasons.keys(), ...archivedKeys]),
          });
          durableNoCandidates = candidates.durableNoCandidates;
          const capStore = candidates.store;
          return { store: capStore, maxEntries: Object.keys(capStore).length - overflow };
        }
        return undefined;
      },
      onRemoved: ({ key }, reason) => removalReasons.set(key, reason),
      onArchived: ({ key }) => archivedKeys.add(key),
    });
  // Intermediate pages are already due; scan future activity only after exhausting them.
  const ageFact = ageContinuation
    ? {
        maintenance,
        entryCount,
        next: { at: plannedAt },
        recheckAt: plannedAt + SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
      }
    : recordSessionEntryMaintenanceAgeFact(reader, maintenance, plannedAt, entryCount);
  const selectedKeys = uniqueStrings([...archivedKeys, ...removalReasons.keys()]);
  if (selectedKeys.length === 0) {
    const value = emptySessionEntryMaintenancePlan();
    if (ageContinuation) {
      value.ageContinuation = ageContinuation;
    }
    if (durableNoCandidates) {
      value.durableNoCandidates = true;
    }
    return (database) => {
      stageSessionEntryMaintenanceAgeFact(database.db, ageFact);
      return value;
    };
  }
  // Selected victims have not changed yet; their future age hint is not committed.
  invalidateSessionEntryMaintenanceAgeFact(reader.db);
  const readInputs = (database: Pick<OpenClawAgentDatabase, "db">) => {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .selectAll()
        .where("session_key", "in", sqliteStringSet(selectedKeys))
        .orderBy("session_key"),
    ).rows;
    return {
      rows,
      transcripts: readTranscriptContextVersionsInTransaction(
        database,
        uniqueStrings(rows.map((row) => row.current_session_id)),
      ),
      parents: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select(["session_key", "parent_session_key"])
          .where("archived_at", "is", null)
          .where("session_key", "in", sqliteStringSet(baseKeys))
          .orderBy("session_key"),
      ).rows,
    };
  };
  const expected = readInputs(reader);
  return (database, onArchived, postimages) => {
    if (
      !isDeepStrictEqual(expected, readInputs(database)) ||
      (capArchived + capped > 0 &&
        readSessionEntryCount(database, { includeArchived: false }) < entryCount)
    ) {
      throw new SqliteReclamationInputsChangedError(
        "SQLite maintenance candidate rows changed before commit",
      );
    }
    const readSelected = prepareExactSessionEntryRowReads(
      database,
      selectedKeys,
      "full",
      "canonical",
      postimages
        ? { includeWindowFacts: true, includeBoardPresence: true, includeMembership: true }
        : { includeWindowFacts: true, projectParticipants: false },
    );
    const selectedEntries: Record<string, SessionEntry> = {};
    const selectedRows = new Map<string, NonNullable<ReturnType<typeof readSelected>>>();
    for (const key of selectedKeys) {
      const selected = readSelected(key);
      if (selected) {
        selectedEntries[key] = selected.entry;
        selectedRows.set(key, selected);
      }
    }
    if (selectedKeys.length > 0) {
      // Admission refreshes live protection after planning. Reread only its active
      // ancestry under the writer lock; unrelated activity cannot invalidate victims.
      const currentBaseKeys = collectSqliteSessionMaintenanceBaseKeys(
        (keys) => readSessionMaintenanceKeyProjection(database, keys),
        [params.activeSessionKey ?? "", ...(params.activeSessionKeys ?? [])],
        baseKeys,
      );
      const currentPreserveKeys = resolveSessionMaintenancePreserveKeys({
        snapshot: refreshCandidates ? refreshCandidates(selectedKeys) : readPreservation(),
        store: selectedEntries,
        baseKeys: currentBaseKeys,
      });
      if (selectedKeys.some((key) => currentPreserveKeys.has(normalizeStoreSessionKey(key)))) {
        throw new SqliteReclamationInputsChangedError(
          "SQLite maintenance candidates became protected before commit",
        );
      }
    }
    const archivedEntries: SessionEntryMaintenancePlan["archivedEntries"] = [];
    const archiveWrites: Parameters<typeof writeArchivedSessionEntries>[1][number][] = [];
    for (const key of archivedKeys) {
      const previousEntry = selectedEntries[key];
      const planned = store[key];
      if (!previousEntry || !planned?.archivedAt) {
        continue;
      }
      const entry = {
        ...previousEntry,
        archivedAt: planned.archivedAt,
        archiveReason: planned.archiveReason,
      };
      delete entry.archivedBy;
      archiveWrites.push({ sessionKey: key, entry, previous: selectedRows.get(key)! });
      archivedEntries.push({ sessionKey: key, sessionId: entry.sessionId });
    }
    const written = writeArchivedSessionEntries(database, archiveWrites, postimages);
    archiveWrites.forEach((write, index) =>
      onArchived?.(write.sessionKey, write.previous.entry, written[index]!),
    );
    const removals = [...removalReasons].flatMap(([sessionKey, maintenanceReason]) => {
      const expectedEntry = selectedEntries[sessionKey];
      return expectedEntry ? [{ expectedEntry, maintenanceReason, sessionKey }] : [];
    });
    stageSessionEntryMaintenanceAgeFact(database.db, ageFact);
    if (removals.length === 0) {
      return {
        ...(ageContinuation ? { ageContinuation } : {}),
        archivedEntries,
        entryRemovals: [],
        stateDeletePlans: [],
        archived,
        capArchived,
        modelRunPruned: 0,
        pruned: 0,
        capped: capArchived,
      };
    }
    const removedSessionIds = new Set<string>();
    for (const removal of removals) {
      for (const sessionId of collectSessionStateIdsForEntry(removal.expectedEntry)) {
        removedSessionIds.add(sessionId);
      }
    }
    for (const sessionId of readSessionGenerationIdsForKeys(
      database,
      removals.map((removal) => removal.sessionKey),
    )) {
      removedSessionIds.add(sessionId);
    }
    const referencedSessionIds = collectProjectedReferencedSessionIds({
      database,
      excludedSessionKeys: removals.map((removal) => removal.sessionKey),
      projectedStore: {},
      candidateSessionIds: [...removedSessionIds],
    });
    const deletePlans: SessionStateDeletePlan[] = [];
    for (const sessionId of removedSessionIds) {
      const plan = planSessionStateDeleteIfUnreferenced({
        archiveTranscript: true,
        archiveDirectory: params.archiveDirectory,
        database,
        referencedSessionIds,
        sessionId,
      });
      if (plan) {
        deletePlans.push(plan);
      }
    }
    return {
      ...(ageContinuation ? { ageContinuation } : {}),
      archivedEntries,
      entryRemovals: removals,
      stateDeletePlans: deletePlans,
      archived,
      capArchived,
      modelRunPruned,
      pruned,
      capped,
    };
  };
}
