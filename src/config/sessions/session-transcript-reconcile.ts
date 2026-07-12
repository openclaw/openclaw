import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { extractTranscriptIndexEntry } from "./session-transcript-index.js";
import {
  resolveVisibleTranscriptAppendParentId,
  selectVisibleTranscriptEventEntries,
} from "./transcript-visible-events.js";

const RECONCILE_BATCH_SIZE = 64;
// Bounds abandoned ownership while leaving headroom for one synchronous
// planning phase between worker progress and claim-refresh boundaries.
const RECONCILE_CLAIM_LEASE_MS = 5 * 60_000;

type ReconcileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "sessions" | "session_transcript_index_state" | "transcript_events"
>;
type PlannedEntry = NonNullable<ReturnType<typeof extractTranscriptIndexEntry>>;

function kysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ReconcileDatabase>(db);
}

function readRevision(db: DatabaseSync, sessionId: string): number | null | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("sessions")
      .select("transcript_updated_at")
      .where("session_id", "=", sessionId),
  )?.transcript_updated_at;
}

function ownsClaim(db: DatabaseSync, sessionId: string, token: number): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      kysely(db)
        .selectFrom("session_transcript_index_state")
        .select("needs_rebuild")
        .where("session_id", "=", sessionId),
    )?.needs_rebuild === token
  );
}

function refreshClaim(db: DatabaseSync, sessionId: string, token: number): void {
  const currentUpdatedAt = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("session_transcript_index_state")
      .select("updated_at")
      .where("session_id", "=", sessionId)
      .where("needs_rebuild", "=", token),
  )?.updated_at;
  if (currentUpdatedAt === undefined) {
    return;
  }
  executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("session_transcript_index_state")
      .set({ updated_at: Math.max(Date.now(), token, currentUpdatedAt) })
      .where("session_id", "=", sessionId)
      .where("needs_rebuild", "=", token),
  );
}

function tryClaimSession(
  db: DatabaseSync,
  sessionId: string,
  expectedRevision: number | null | undefined,
): number | undefined {
  if (readRevision(db, sessionId) !== expectedRevision) {
    return undefined;
  }
  const latestSeq = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  )?.seq;
  if (latestSeq === undefined) {
    return undefined;
  }
  const state = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild", "updated_at"])
      .where("session_id", "=", sessionId),
  );
  const now = Date.now();
  const reclaimable =
    state !== undefined &&
    state.needs_rebuild > 1 &&
    state.updated_at <= now - RECONCILE_CLAIM_LEASE_MS;
  if (state && !reclaimable && state.needs_rebuild !== 1 && state.indexed_seq >= latestSeq) {
    return undefined;
  }
  if (!state) {
    const token = Math.max(2, now);
    const inserted = executeSqliteQuerySync(
      db,
      kysely(db)
        .insertInto("session_transcript_index_state")
        .values({
          session_id: sessionId,
          indexed_seq: -1,
          leaf_event_id: null,
          needs_rebuild: token,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.column("session_id").doNothing()),
    );
    return (inserted.numAffectedRows ?? 0n) === 1n ? token : undefined;
  }
  // Claim identity is a DB-owned monotonic generation, not randomness. Every
  // transcript mutation advances updated_at before resetting needs_rebuild=1,
  // so an invalidated worker can never match a later claimant's token.
  const token = Math.max(2, now, state.updated_at + 1);
  const claimed = executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("session_transcript_index_state")
      .set({ needs_rebuild: token, updated_at: token })
      .where("session_id", "=", sessionId)
      .where("needs_rebuild", "in", reclaimable ? [0, 1, state.needs_rebuild] : [0, 1])
      .where("updated_at", "=", state.updated_at),
  );
  return (claimed.numAffectedRows ?? 0n) === 1n ? token : undefined;
}

function selectSessionIds(db: DatabaseSync): string[] {
  const abandonedBefore = Date.now() - RECONCILE_CLAIM_LEASE_MS;
  const rows = executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom("sessions")
      .innerJoin("transcript_events as latest", (join) =>
        join
          .onRef("latest.session_id", "=", "sessions.session_id")
          .on((eb) =>
            eb(
              "latest.seq",
              "=",
              eb
                .selectFrom("transcript_events as candidate")
                .select("candidate.seq")
                .whereRef("candidate.session_id", "=", "sessions.session_id")
                .orderBy("candidate.seq", "desc")
                .limit(1),
            ),
          ),
      )
      .leftJoin(
        "session_transcript_index_state as state",
        "state.session_id",
        "sessions.session_id",
      )
      .select("sessions.session_id")
      .where((eb) =>
        eb.or([
          eb(eb.fn.coalesce("state.needs_rebuild", eb.val(1)), "=", 1),
          eb("latest.seq", ">", eb.fn.coalesce("state.indexed_seq", eb.val(-1))),
          eb.and([
            eb("state.needs_rebuild", ">", 1),
            eb("state.updated_at", "<=", abandonedBefore),
          ]),
        ]),
      )
      .orderBy("sessions.session_id"),
  ).rows;
  return rows.map((row) => row.session_id);
}

function selectFtsRowIds(db: DatabaseSync, sessionId: string): Array<number | bigint> {
  return (
    db
      .prepare(
        /* sqlite-allow-raw: FTS5 has no Kysely rowid model; scan happens outside BEGIN */
        "SELECT rowid FROM session_transcript_fts WHERE session_id = ?",
      )
      .all(sessionId) as Array<{ rowid: number | bigint }>
  ).map((row) => row.rowid);
}

function deleteFtsRows(db: DatabaseSync, rowIds: readonly (number | bigint)[]): void {
  const remove = db.prepare(
    /* sqlite-allow-raw: bounded primary rowid deletes */
    "DELETE FROM session_transcript_fts WHERE rowid = ?",
  );
  for (const rowId of rowIds) {
    remove.run(rowId);
  }
}

function insertFtsRows(
  db: DatabaseSync,
  sessionId: string,
  entries: readonly PlannedEntry[],
): void {
  const insert = db.prepare(
    /* sqlite-allow-raw: FTS5 virtual-table maintenance */
    "INSERT INTO session_transcript_fts(text, session_id, message_id, role, timestamp) VALUES (?, ?, ?, ?, ?)",
  );
  for (const entry of entries) {
    insert.run(entry.text, sessionId, entry.messageId, entry.role, entry.timestamp);
  }
}

function selectOrphanFtsRowIds(db: DatabaseSync): Array<number | bigint> {
  return (
    db
      .prepare(
        /* sqlite-allow-raw: unindexed FTS scan deliberately stays outside BEGIN */
        "SELECT f.rowid FROM session_transcript_fts AS f WHERE NOT EXISTS (SELECT 1 FROM transcript_events AS e WHERE e.session_id = f.session_id) LIMIT ?",
      )
      .all(RECONCILE_BATCH_SIZE) as Array<{ rowid: number | bigint }>
  ).map((row) => row.rowid);
}

function selectOrphanWatermarks(db: DatabaseSync): string[] {
  return executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom("session_transcript_index_state as state")
      .select("state.session_id")
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("transcript_events as event")
              .select("event.session_id")
              .whereRef("event.session_id", "=", "state.session_id"),
          ),
        ),
      )
      .limit(RECONCILE_BATCH_SIZE),
  ).rows.map((row) => row.session_id);
}

async function reconcileOrphans(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  onPlanning?: () => void;
  onRebuildActive?: () => void;
  onProgress?: () => void;
}): Promise<void> {
  const database = openOpenClawAgentDatabase(params);
  while (true) {
    params.onPlanning?.();
    const rowIds = selectOrphanFtsRowIds(database.db);
    const sessionIds = selectOrphanWatermarks(database.db);
    if (rowIds.length === 0 && sessionIds.length === 0) {
      return;
    }
    params.onRebuildActive?.();
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        const removeFts = agentDatabase.db.prepare(
          /* sqlite-allow-raw: revalidates transcript absence inside the short write */
          "DELETE FROM session_transcript_fts WHERE rowid = ? AND NOT EXISTS (SELECT 1 FROM transcript_events AS e WHERE e.session_id = session_transcript_fts.session_id)",
        );
        for (const rowId of rowIds) {
          removeFts.run(rowId);
        }
        for (const sessionId of sessionIds) {
          executeSqliteQuerySync(
            agentDatabase.db,
            kysely(agentDatabase.db)
              .deleteFrom("session_transcript_index_state")
              .where("session_id", "=", sessionId)
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom("transcript_events")
                      .select("session_id")
                      .where("session_id", "=", sessionId),
                  ),
                ),
              ),
          );
        }
      },
      params,
      { operationLabel: "sessions.search.reconcile.orphan-batch" },
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    params.onProgress?.();
  }
}

/** Reconcile dirty transcript indexes without holding a write lock during planning or FTS scans. */
export async function reconcileSessionTranscriptIndexes(params: {
  agentId: string;
  stateDir: string;
  onRebuildActive?: () => void;
  onPlanning?: () => void;
  onProgress?: () => void;
}): Promise<void> {
  const env = { OPENCLAW_STATE_DIR: params.stateDir };
  const database = openOpenClawAgentDatabase({ agentId: params.agentId, env });
  for (const sessionId of selectSessionIds(database.db)) {
    params.onPlanning?.();
    const revision = readRevision(database.db, sessionId);
    const rows = executeSqliteQuerySync(
      database.db,
      kysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", "event_json"])
        .where("session_id", "=", sessionId)
        .orderBy("seq"),
    ).rows;
    if (rows.length === 0) {
      continue;
    }
    const events = rows.map((row) => JSON.parse(row.event_json) as unknown);
    const now = Date.now();
    const entries = selectVisibleTranscriptEventEntries(events).flatMap(({ event }) => {
      const entry = extractTranscriptIndexEntry(event, now);
      return entry ? [entry] : [];
    });
    const maxSeq = rows.at(-1)?.seq ?? -1;
    const leafEventId = resolveVisibleTranscriptAppendParentId(events);
    const rowIds = selectFtsRowIds(database.db, sessionId);
    let token: number | undefined;
    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        token = tryClaimSession(agentDatabase.db, sessionId, revision);
      },
      { agentId: params.agentId, env },
      { operationLabel: "sessions.search.reconcile.claim" },
    );
    if (token === undefined) {
      continue;
    }
    const claimToken = token;
    // Planning and the potentially full UNINDEXED scan are complete. From this
    // point onward, progress consists only of claim-guarded bounded writes.
    params.onRebuildActive?.();

    let owns = true;
    for (let offset = 0; offset < rowIds.length; offset += RECONCILE_BATCH_SIZE) {
      if (!owns) {
        break;
      }
      const batch = rowIds.slice(offset, offset + RECONCILE_BATCH_SIZE);
      runOpenClawAgentWriteTransaction(
        (agentDatabase) => {
          owns = ownsClaim(agentDatabase.db, sessionId, claimToken);
          if (owns) {
            deleteFtsRows(agentDatabase.db, batch);
            refreshClaim(agentDatabase.db, sessionId, claimToken);
          }
        },
        { agentId: params.agentId, env },
        { operationLabel: "sessions.search.reconcile.delete-batch" },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      params.onProgress?.();
    }
    for (let offset = 0; offset < entries.length; offset += RECONCILE_BATCH_SIZE) {
      if (!owns) {
        break;
      }
      const batch = entries.slice(offset, offset + RECONCILE_BATCH_SIZE);
      runOpenClawAgentWriteTransaction(
        (agentDatabase) => {
          owns = ownsClaim(agentDatabase.db, sessionId, claimToken);
          if (owns) {
            insertFtsRows(agentDatabase.db, sessionId, batch);
            refreshClaim(agentDatabase.db, sessionId, claimToken);
          }
        },
        { agentId: params.agentId, env },
        { operationLabel: "sessions.search.reconcile.insert-batch" },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      params.onProgress?.();
    }
    if (!owns) {
      continue;
    }

    runOpenClawAgentWriteTransaction(
      (agentDatabase) => {
        if (readRevision(agentDatabase.db, sessionId) !== revision) {
          return;
        }
        const claimUpdatedAt = executeSqliteQueryTakeFirstSync(
          agentDatabase.db,
          kysely(agentDatabase.db)
            .selectFrom("session_transcript_index_state")
            .select("updated_at")
            .where("session_id", "=", sessionId)
            .where("needs_rebuild", "=", claimToken),
        )?.updated_at;
        if (claimUpdatedAt === undefined) {
          return;
        }
        executeSqliteQuerySync(
          agentDatabase.db,
          kysely(agentDatabase.db)
            .updateTable("session_transcript_index_state")
            .set({
              indexed_seq: maxSeq,
              leaf_event_id: leafEventId,
              needs_rebuild: 0,
              updated_at: Math.max(Date.now(), claimToken, claimUpdatedAt),
            })
            .where("session_id", "=", sessionId)
            .where("needs_rebuild", "=", claimToken),
        );
      },
      { agentId: params.agentId, env },
      { operationLabel: "sessions.search.reconcile.publish" },
    );
  }
  await reconcileOrphans({
    agentId: params.agentId,
    env,
    onPlanning: params.onPlanning,
    onRebuildActive: params.onRebuildActive,
    onProgress: params.onProgress,
  });
}
