// Shared row mutations for synchronous session signals and the shared-state worker.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
  SESSION_WATCH_PROVENANCE_EXPLICIT,
  type SessionWatchCursorProvenance,
} from "../state/session-watch-cursor-provenance.js";
import {
  NOTIFY_BY_SESSION_STATE_EVENT_KIND as NOTIFY_BY_KIND,
  type SessionStateActorType,
  type SessionStateEventKind,
} from "./session-state-event-kinds.js";
import {
  rowToSessionUpstreamLink,
  type SessionUpstreamLink,
} from "./session-upstream-links.kernel.js";

export type SessionStateEventInput = {
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  dedupeKey?: string;
  summary: string;
  payload?: Record<string, unknown>;
  occurredAt?: number;
  watcherSessionKeys?: readonly string[];
  watcherStorePaths?: Readonly<Record<string, string>>;
};

export type SessionStateNotice = {
  watcherSessionKey: string;
  watcherStorePath: string | null;
  targetSessionKey: string;
  lastSeenSequence: number;
  queueOnly: boolean;
};

type SessionStateDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "session_state_events" | "session_state_heads" | "session_watch_cursors"
>;
type SessionStateEventsTable = OpenClawStateKyselyDatabase["session_state_events"];
export type SessionStateEventRow = Selectable<SessionStateEventsTable>;
export type SessionStateEventRecord = {
  sequence: number;
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  occurredAt: number;
  summary: string;
  payload?: Record<string, unknown>;
};

export function rowToSessionStateEvent(row: SessionStateEventRow): SessionStateEventRecord {
  const payload = row.payload_json ? safeParseJsonRecord(row.payload_json) : undefined;
  return {
    sequence: normalizeSqliteNumber(row.sequence) ?? 0,
    sessionKey: row.session_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    agentId: row.agent_id,
    // SAFETY: The sole event writer stores SessionStateEventInput.kind unchanged in this TEXT column.
    kind: row.kind as SessionStateEventKind,
    // SAFETY: The same typed recorder stores SessionStateEventInput.actorType unchanged as TEXT.
    actorType: row.actor_type as SessionStateActorType,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    summary: row.summary,
    ...(payload ? { payload } : {}),
  };
}

type SessionWatchCursorRow = Selectable<OpenClawStateKyselyDatabase["session_watch_cursors"]>;

const SESSION_STATE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SESSION_STATE_MAX_ROWS = 50_000;
const watcherSchemas = new WeakSet<DatabaseSync>();
function ensureWatcherStoreColumn(db: DatabaseSync) {
  if (watcherSchemas.has(db)) {
    return;
  }
  ensureColumn(db, "session_watch_cursors", "watcher_store_path TEXT");
  deferSqlitePostCommitPublication(db, () => watcherSchemas.add(db));
}

// Bare keys (session.scope="global") are store-local per agent, but cursors, the
// system-event queue, and heartbeat wakes are keyed by session key alone. A notice
// for one agent's child could be drained and acknowledged by another agent's global
// turn — a cross-A2A metadata leak plus a lost notification. Until watcher identity
// is agent-scoped end-to-end, such watchers get durable events and changesSince but
// no notices.
export function isNotifiableWatcherKey(watcherSessionKey: string): boolean {
  return parseAgentSessionKey(watcherSessionKey) != null;
}

export function getSessionStateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionStateDatabase>(db);
}

export function hasSessionStateWatchersInDatabase(
  db: DatabaseSync,
  targetSessionKey: string,
): boolean {
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .select("watcher_session_key")
        .where("target_session_key", "=", targetSessionKey)
        .limit(1),
    ) !== undefined
  );
}

/** A queued upstream observation must still describe the exact source it inspected. */
export function isSessionStateUpstreamCurrentInDatabase(
  db: DatabaseSync,
  expected: SessionUpstreamLink,
): boolean {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_upstream_links">>(db)
      .selectFrom("session_upstream_links")
      .selectAll()
      .where("session_key", "=", expected.sessionKey)
      .where("agent_id", "=", expected.agentId),
  );
  return row !== undefined && isDeepStrictEqual(rowToSessionUpstreamLink(row), expected);
}

export function normalizeOptionalSqliteNumber(
  value: number | bigint | null | undefined,
): number | undefined {
  return value === undefined ? undefined : normalizeSqliteNumber(value);
}

function bindSessionStateEvent(
  input: SessionStateEventInput,
  occurredAt: number,
): Insertable<SessionStateEventsTable> {
  return {
    dedupe_key: input.dedupeKey ?? null,
    session_key: input.sessionKey,
    session_id: input.sessionId ?? null,
    agent_id: input.agentId,
    kind: input.kind,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    run_id: input.runId ?? null,
    occurred_at: occurredAt,
    summary: input.summary,
    payload_json: input.payload ? JSON.stringify(input.payload) : null,
  };
}

export function readCursor(
  db: DatabaseSync,
  watcherSessionKey: string,
  targetSessionKey: string,
): SessionWatchCursorRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getSessionStateKysely(db)
      .selectFrom("session_watch_cursors")
      .selectAll()
      .where("watcher_session_key", "=", watcherSessionKey)
      .where("target_session_key", "=", targetSessionKey),
  );
}

function readMaterialCursors(
  db: DatabaseSync,
  watcherSessionKeys: readonly string[],
  targetSessionKey: string,
): Map<string, SessionWatchCursorRow> | undefined {
  // Node binds lone surrogates as U+FFFD. Aliased keys must observe earlier writes.
  if (watcherSessionKeys.length <= 1 || watcherSessionKeys.some((key) => !key.isWellFormed())) {
    return undefined;
  }
  const cursors = new Map<string, SessionWatchCursorRow>();
  for (let offset = 0; offset < watcherSessionKeys.length; offset += 500) {
    const rows = executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .selectAll()
        .where("target_session_key", "=", targetSessionKey)
        .where("watcher_session_key", "in", watcherSessionKeys.slice(offset, offset + 500)),
    ).rows;
    for (const row of rows) {
      cursors.set(row.watcher_session_key, row);
    }
  }
  return cursors;
}

export function isAmbientGroupWatchCursor(row: SessionWatchCursorRow | undefined): boolean {
  return row?.provenance === SESSION_WATCH_PROVENANCE_AMBIENT_GROUP;
}

export function upsertSeedCursor(params: {
  db: DatabaseSync;
  watcherSessionKey: string;
  watcherStorePath?: string;
  targetSessionKey: string;
  sequence: number;
  now: number;
  provenance?: SessionWatchCursorProvenance;
}): void {
  ensureWatcherStoreColumn(params.db);
  executeSqliteQuerySync(
    params.db,
    getSessionStateKysely(params.db)
      .insertInto("session_watch_cursors")
      .values({
        watcher_session_key: params.watcherSessionKey,
        watcher_store_path: params.watcherStorePath ?? null,
        target_session_key: params.targetSessionKey,
        last_seen_sequence: params.sequence,
        notified_sequence: params.sequence,
        material_sequence: params.sequence,
        provenance: params.provenance ?? SESSION_WATCH_PROVENANCE_EXPLICIT,
        updated_at: params.now,
      })
      .onConflict((conflict) =>
        conflict.columns(["watcher_session_key", "target_session_key"]).doUpdateSet({
          watcher_store_path: params.watcherStorePath ?? null,
          provenance: params.provenance ?? SESSION_WATCH_PROVENANCE_EXPLICIT,
          last_seen_sequence: params.sequence,
          notified_sequence: params.sequence,
          material_sequence: params.sequence,
          updated_at: params.now,
        }),
      ),
  );
}

function updateMaterialCursor(params: {
  db: DatabaseSync;
  current: SessionWatchCursorRow | undefined;
  watcherSessionKey: string;
  watcherStorePath?: string;
  targetSessionKey: string;
  sequence: number;
  now: number;
}): { lastSeenSequence: number; queueOnly: boolean; watcherStorePath: string | null } {
  const { current } = params;
  const watcherStorePath = current
    ? (current.watcher_store_path ?? null)
    : (params.watcherStorePath ?? null);
  const lastSeen = normalizeOptionalSqliteNumber(current?.last_seen_sequence) ?? 0;
  if (
    current &&
    params.watcherStorePath !== undefined &&
    params.watcherStorePath !== watcherStorePath
  ) {
    return { lastSeenSequence: lastSeen, queueOnly: false, watcherStorePath: null };
  }
  ensureWatcherStoreColumn(params.db);
  const notified = normalizeOptionalSqliteNumber(current?.notified_sequence) ?? 0;
  const frozenNotified = notified === lastSeen ? params.sequence : notified;
  executeSqliteQuerySync(
    params.db,
    getSessionStateKysely(params.db)
      .insertInto("session_watch_cursors")
      .values({
        watcher_session_key: params.watcherSessionKey,
        watcher_store_path: watcherStorePath,
        target_session_key: params.targetSessionKey,
        last_seen_sequence: lastSeen,
        notified_sequence: frozenNotified,
        material_sequence: params.sequence,
        provenance: SESSION_WATCH_PROVENANCE_EXPLICIT,
        updated_at: params.now,
      })
      .onConflict((conflict) =>
        conflict.columns(["watcher_session_key", "target_session_key"]).doUpdateSet({
          notified_sequence: frozenNotified,
          material_sequence: params.sequence,
          updated_at: params.now,
        }),
      ),
  );
  return {
    lastSeenSequence: lastSeen,
    queueOnly: isAmbientGroupWatchCursor(current),
    watcherStorePath,
  };
}

const SESSION_STATE_OCCURRED_AT_MAX_SKEW_MS = 24 * 60 * 60_000;

// Upstream-sourced event times are display/history truth only. Bookkeeping clocks
// (heads, cursors, prune scheduling) must use local time, or one skewed upstream
// timestamp could age-out watch cursors instantly; the clamp bounds retention skew.
function clampSessionStateOccurredAt(value: number | undefined, now: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return now;
  }
  return Math.min(Math.max(value, now - SESSION_STATE_OCCURRED_AT_MAX_SKEW_MS), now);
}

/** The caller owns one synchronous transaction for the event, head, and cursors. */
export function recordSessionStateEventInDatabase(
  db: DatabaseSync,
  input: SessionStateEventInput,
  now: number,
): { row?: SessionStateEventRow; notices: SessionStateNotice[] } {
  const occurredAt = clampSessionStateOccurredAt(input.occurredAt, now);
  const notices: SessionStateNotice[] = [];
  const insert = executeSqliteQuerySync(
    db,
    getSessionStateKysely(db)
      .insertInto("session_state_events")
      .values(bindSessionStateEvent(input, occurredAt))
      .onConflict((conflict) => conflict.column("dedupe_key").doNothing()),
  );
  const insertedSequence = insert.insertId ? Number(insert.insertId) : undefined;
  if (insertedSequence === undefined) {
    if (!input.dedupeKey) {
      return { notices };
    }
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_state_events")
        .selectAll()
        .where("dedupe_key", "=", input.dedupeKey),
    );
    return { row: existing, notices };
  }

  executeSqliteQuerySync(
    db,
    getSessionStateKysely(db)
      .insertInto("session_state_heads")
      .values({
        session_key: input.sessionKey,
        agent_id: input.agentId,
        last_sequence: insertedSequence,
        updated_at: now,
      })
      .onConflict((conflict) =>
        // (session_key, agent_id) composite identity: under session.scope="global"
        // every agent owns a session-store row keyed "global"; a key-only head
        // would let agents overwrite each other's version heads.
        conflict.columns(["session_key", "agent_id"]).doUpdateSet({
          last_sequence: insertedSequence,
          updated_at: now,
        }),
      ),
  );

  // Explicit watch registrations (registerSessionStateWatch) live as cursor rows;
  // union them with producer-passed watchers so sessions_send coordinators get
  // notices without every producer knowing about registration.
  const registeredWatcherKeys = NOTIFY_BY_KIND[input.kind]
    ? executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_watch_cursors")
          .select("watcher_session_key")
          .where("target_session_key", "=", input.sessionKey),
      ).rows.map((row) => row.watcher_session_key)
    : [];
  const watcherSessionKeys = [
    ...new Set([...(input.watcherSessionKeys ?? []), ...registeredWatcherKeys]),
  ].filter((key) => Boolean(key) && isNotifiableWatcherKey(key));
  const cursors =
    NOTIFY_BY_KIND[input.kind] && watcherSessionKeys.length > 1
      ? readMaterialCursors(
          db,
          watcherSessionKeys.filter((key) => key !== input.actorId),
          input.sessionKey,
        )
      : undefined;
  for (const watcherSessionKey of watcherSessionKeys) {
    if (input.kind === "child_spawned") {
      upsertSeedCursor({
        db,
        watcherSessionKey,
        watcherStorePath: input.watcherStorePaths?.[watcherSessionKey],
        targetSessionKey: input.sessionKey,
        sequence: insertedSequence,
        now,
      });
      continue;
    }
    if (!NOTIFY_BY_KIND[input.kind] || input.actorId === watcherSessionKey) {
      continue;
    }
    const materialCursor = updateMaterialCursor({
      db,
      current: cursors
        ? cursors.get(watcherSessionKey)
        : readCursor(db, watcherSessionKey, input.sessionKey),
      watcherSessionKey,
      watcherStorePath: input.watcherStorePaths?.[watcherSessionKey],
      targetSessionKey: input.sessionKey,
      sequence: insertedSequence,
      now,
    });
    notices.push({
      watcherSessionKey,
      watcherStorePath: materialCursor.watcherStorePath,
      targetSessionKey: input.sessionKey,
      lastSeenSequence: materialCursor.lastSeenSequence,
      queueOnly: materialCursor.queueOnly,
    });
  }

  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSessionStateKysely(db)
      .selectFrom("session_state_events")
      .selectAll()
      .where("sequence", "=", insertedSequence),
  );
  return { row, notices };
}

/** The caller owns the transaction and schedules retention after notice publication. */
export function pruneSessionStateEventsInDatabase(db: DatabaseSync, now: number): void {
  const kysely = getSessionStateKysely(db);
  // Stamp per-session pruned watermarks BEFORE deleting: historyGap can only be
  // answered from what pruning actually removed for that session, never inferred
  // from globally sparse sequence arithmetic.
  const stampPrunedWatermarks = (predicate: {
    occurredBefore?: number;
    sequenceAtOrBelow?: number;
  }) => {
    let query = kysely
      .selectFrom("session_state_events")
      .select(["session_key", "agent_id"])
      .select((eb) => eb.fn.max<number>("sequence").as("max_sequence"))
      .groupBy(["session_key", "agent_id"]);
    if (predicate.occurredBefore !== undefined) {
      query = query.where("occurred_at", "<", predicate.occurredBefore);
    }
    if (predicate.sequenceAtOrBelow !== undefined) {
      query = query.where("sequence", "<=", predicate.sequenceAtOrBelow);
    }
    // Decode the whole aggregate before any writes, retaining native integer errors.
    const rows = executeSqliteQuerySync(db, query).rows;
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      const selections = batch.map((row) =>
        kysely.selectNoFrom((eb) => [
          eb.val(row.session_key).as("session_key"),
          eb.val(row.agent_id).as("agent_id"),
          eb.val(normalizeSqliteNumber(row.max_sequence) ?? 0).as("max_sequence"),
        ]),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .with("pruned", () => selections[0]!.unionAll(selections.slice(1)))
          .with("watermarks", (qb) =>
            // Decoding and rebinding malformed UTF-8 can collapse distinct stored keys.
            qb
              .selectFrom("pruned")
              .select(["session_key", "agent_id"])
              .select((eb) => eb.fn.max<number>("max_sequence").as("max_sequence"))
              .groupBy(["session_key", "agent_id"]),
          )
          .updateTable("session_state_heads")
          .from("watermarks")
          .set((eb) => ({
            pruned_max_sequence: eb.ref("watermarks.max_sequence"),
            updated_at: now,
          }))
          .whereRef("session_state_heads.session_key", "=", "watermarks.session_key")
          .whereRef("session_state_heads.agent_id", "=", "watermarks.agent_id")
          .whereRef("session_state_heads.pruned_max_sequence", "<", "watermarks.max_sequence"),
      );
    }
  };
  const retentionCutoff = now - SESSION_STATE_RETENTION_MS;
  stampPrunedWatermarks({ occurredBefore: retentionCutoff });
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("session_state_events").where("occurred_at", "<", retentionCutoff),
  );
  const overflowRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_state_events")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(SESSION_STATE_MAX_ROWS)
      .limit(1),
  );
  const sequenceCutoff = normalizeOptionalSqliteNumber(overflowRow?.sequence);
  if (sequenceCutoff !== undefined) {
    stampPrunedWatermarks({ sequenceAtOrBelow: sequenceCutoff });
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("session_state_events").where("sequence", "<=", sequenceCutoff),
    );
  }
  const cursorCutoff = now - SESSION_STATE_RETENTION_MS;
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("session_watch_cursors").where("updated_at", "<", cursorCutoff),
  );
}
