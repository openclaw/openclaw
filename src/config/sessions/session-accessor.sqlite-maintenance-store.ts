import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import {
  readSessionEntryCount,
  readSessionEntryStore,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import {
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  invalidateSessionEntryMaintenanceAgeFact,
  readSessionEntryMaintenanceAgeFact,
  recordSessionEntryMaintenanceAgeFact,
  stageSessionEntryMaintenanceAgeFact,
} from "./session-accessor.sqlite-maintenance-age.js";
import {
  collectSqliteSessionMaintenanceBaseKeys,
  readSessionMaintenanceAgeCandidates,
  readSessionMaintenanceCapCandidates,
  readSessionMaintenanceKeyProjection,
} from "./session-accessor.sqlite-maintenance-candidates.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import { cloneSessionEntry, getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { planSessionEntryMaintenance } from "./store-maintenance-plan.js";
import {
  resolveSessionMaintenancePreserveKeys,
  type SessionMaintenancePreservationSnapshot,
} from "./store-maintenance-preserve-snapshot.js";
import { shouldRunSessionEntryMaintenance } from "./store-maintenance.js";

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
        sql<number | bigint>`SUM(${transcriptEventReadBytesSql()} + 1)`.as("jsonl_bytes"),
      ])
      .where("session_id", "in", sessionIds)
      .groupBy("session_id"),
  ).rows;
  return new Map(rows.map((row) => [row.session_id, sqliteNumber(row.jsonl_bytes)]));
}

export function refreshSessionPlannerStatisticsInDatabase(database: OpenClawAgentDatabase): void {
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
    archivedSessionKeys: [],
    entryRemovals: [],
    stateDeletePlans: [],
    archived: 0,
    capArchived: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
}

/** Only a current age fact can avoid planning; pressure and force still require a pass. */
function canSkipSessionEntryMaintenanceInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  params: Pick<SessionEntryMaintenanceInput, "maintenance" | "forceMaintenance">,
  entryCount: number,
): boolean {
  if (params.forceMaintenance) {
    return false;
  }
  const ageFact = readSessionEntryMaintenanceAgeFact(database.db, params.maintenance);
  return (
    ageFact !== undefined &&
    Date.now() < ageFact.next.at &&
    !shouldRunSessionEntryMaintenance({
      entryCount,
      maxEntries: params.maintenance.maxEntries,
      force: params.forceMaintenance,
    })
  );
}

/** Inline callers already hold their transaction; workers prepare before write admission. */
export function applySessionEntryMaintenanceInDatabase(
  database: OpenClawAgentDatabase,
  params: Omit<SessionEntryMaintenanceInput, "preservation">,
  readPreservation: () => SessionMaintenancePreservationSnapshot,
): SessionEntryMaintenancePlan {
  return prepareSessionEntryMaintenanceInDatabase(database, params, readPreservation)(database);
}

/** Prepare outside write admission; compare only selected rows and protection dependencies inside it. */
export function prepareSessionEntryMaintenanceInDatabase(
  reader: Pick<OpenClawAgentDatabase, "db">,
  params: Omit<SessionEntryMaintenanceInput, "preservation">,
  readPreservation: () => SessionMaintenancePreservationSnapshot,
): (database: OpenClawAgentDatabase) => SessionEntryMaintenancePlan {
  const maintenance = params.maintenance;
  if (maintenance.mode === "warn") {
    return emptySessionEntryMaintenancePlan;
  }

  // Key projections and indexed age candidates keep unrelated entry payloads out
  // of automatic maintenance. Exact full entries load only for rows selected to change.
  const entryCount = readSessionEntryCount(reader, { includeArchived: false });
  if (canSkipSessionEntryMaintenanceInDatabase(reader, params, entryCount)) {
    return emptySessionEntryMaintenancePlan;
  }
  invalidateSessionEntryMaintenanceAgeFact(reader.db);
  const plannedAt = Date.now();
  const activeSessionKeys = uniqueStrings([
    params.activeSessionKey ?? "",
    ...(params.activeSessionKeys ?? []),
  ]);
  const removalReasons = new Map<
    string,
    NonNullable<SessionEntryMaintenancePlan["entryRemovals"][number]["maintenanceReason"]>
  >();
  const archivedKeys = new Set<string>();
  let preserveKeys: ReadonlySet<string> | undefined;
  let baseKeys: string[] = [];
  const readPreserveKeys = () => {
    if (!preserveKeys) {
      const snapshot = readPreservation();
      const keyProjection = readSessionMaintenanceKeyProjection(reader);
      baseKeys = collectSqliteSessionMaintenanceBaseKeys(keyProjection, activeSessionKeys);
      preserveKeys = resolveSessionMaintenancePreserveKeys({
        snapshot,
        store: keyProjection,
        baseKeys,
      });
    }
    return preserveKeys;
  };
  const { store, archived, capArchived, modelRunPruned, pruned, capped } =
    planSessionEntryMaintenance({
      profile: "write",
      maintenance,
      initialUnarchivedCount: entryCount,
      forceMaintenance: params.forceMaintenance,
      readPreserveKeys,
      log: false,
      readAgeCandidates: (minimumAgeMs) =>
        readSessionMaintenanceAgeCandidates({
          database: reader,
          minimumAgeMs,
          pruneAfterMs: maintenance.pruneAfterMs,
        }),
      readCapCandidates: (remainingEntryCount) => {
        const overflow = Math.max(0, remainingEntryCount - maintenance.maxEntries);
        if (overflow > 0) {
          const capStore = readSessionMaintenanceCapCandidates({
            database: reader,
            overflow,
            preserveKeys: readPreserveKeys(),
            preserveRecentMs: maintenance.preserveRecentMs,
            excludedKeys: new Set([...removalReasons.keys(), ...archivedKeys]),
          });
          return { store: capStore, maxEntries: Object.keys(capStore).length - overflow };
        }
        return undefined;
      },
      onRemoved: ({ key }, reason) => removalReasons.set(key, reason),
      onArchived: ({ key }) => archivedKeys.add(key),
    });
  const ageFact = recordSessionEntryMaintenanceAgeFact(reader, maintenance, plannedAt);
  const selectedKeys = uniqueStrings([...archivedKeys, ...removalReasons.keys()]);
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
      transcripts: uniqueStrings(rows.map((row) => row.current_session_id)).map((sessionId) =>
        readTranscriptContextVersionInTransaction(database, sessionId),
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
  const expected = selectedKeys.length > 0 ? readInputs(reader) : undefined;
  return (database) => {
    if (
      expected &&
      (!isDeepStrictEqual(expected, readInputs(database)) ||
        (capArchived + capped > 0 &&
          readSessionEntryCount(database, { includeArchived: false }) < entryCount))
    ) {
      throw new SqliteReclamationInputsChangedError(
        "SQLite maintenance candidate rows changed before commit",
      );
    }
    const selectedEntries = readSessionEntryStore(database, { sessionKeys: selectedKeys });
    const archivedSessionKeys: string[] = [];
    const archivedWorktrees: NonNullable<SessionEntryMaintenancePlan["archivedWorktrees"]> = [];
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
      writeSessionEntry(database, key, entry, { canonicalPreviousEntry: previousEntry });
      archivedSessionKeys.push(key);
      if (entry.worktree) {
        archivedWorktrees.push({
          entry: cloneSessionEntry(entry),
          sessionKey: key,
          storePath: params.storePath,
        });
      }
    }
    const removals = [...removalReasons].flatMap(([sessionKey, maintenanceReason]) => {
      const expectedEntry = selectedEntries[sessionKey];
      return expectedEntry ? [{ expectedEntry, maintenanceReason, sessionKey }] : [];
    });
    stageSessionEntryMaintenanceAgeFact(database.db, ageFact);
    if (removals.length === 0) {
      return {
        archivedSessionKeys,
        ...(archivedWorktrees.length ? { archivedWorktrees } : {}),
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
      archivedSessionKeys,
      ...(archivedWorktrees.length ? { archivedWorktrees } : {}),
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
