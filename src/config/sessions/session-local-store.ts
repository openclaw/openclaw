// Per-agent durable state for live local sessions: the projection checkpoint that
// bounds replay after reconnect, and the team-input ledger where every submission
// ends in a recorded outcome (Product Doctrine: no silent non-outcomes).
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";

type LocalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_local_mirror_checkpoints" | "session_local_inputs"
>;

export type LocalSessionInputState = "accepted" | "submitted" | "committed" | "rejected";

export type LocalSessionInputRecord = {
  inputId: string;
  sessionKey: string;
  sessionId: string;
  senderProfileId?: string;
  senderLabel: string;
  queueMode: "steer" | "followup";
  text: string;
  state: LocalSessionInputState;
  nativeRef?: string;
  reason?: string;
  acceptedAt: number;
  settledAt?: number;
};

export type LocalSessionMirrorCheckpoint = {
  sessionId: string;
  deviceId: string;
  threadId: string;
  acceptedSeq: number;
  earliestSeq?: number;
  updatedAt: number;
};

function kysely(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<LocalSessionDatabase>(database.db);
}

type CheckpointRow = LocalSessionDatabase["session_local_mirror_checkpoints"];
type InputRow = LocalSessionDatabase["session_local_inputs"];

function rowToCheckpoint(row: CheckpointRow): LocalSessionMirrorCheckpoint {
  return {
    sessionId: row.session_id,
    deviceId: row.device_id,
    threadId: row.thread_id,
    acceptedSeq: row.accepted_seq,
    ...(row.earliest_seq === null ? {} : { earliestSeq: row.earliest_seq }),
    updatedAt: row.updated_at,
  };
}

function rowToInput(row: InputRow): LocalSessionInputRecord {
  return {
    inputId: row.input_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    ...(row.sender_profile_id === null ? {} : { senderProfileId: row.sender_profile_id }),
    senderLabel: row.sender_label,
    // SAFETY: column has a CHECK constraint limiting it to these values.
    queueMode: row.queue_mode as "steer" | "followup",
    text: row.text,
    // SAFETY: column has a CHECK constraint limiting it to the input states.
    state: row.state as LocalSessionInputState,
    ...(row.native_ref === null ? {} : { nativeRef: row.native_ref }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    acceptedAt: row.accepted_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
  };
}

function read<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "db">) => T,
): T {
  const result = withOpenClawAgentDatabaseReadOnly(
    operation,
    toDatabaseOptions(resolveSqliteScope(scope)),
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : fallback;
}

export function readLocalSessionMirrorCheckpoint(
  scope: SessionAccessScope,
  sessionId: string,
): LocalSessionMirrorCheckpoint | undefined {
  return read(scope, undefined, (database) => {
    const row = executeSqliteQuerySync(
      database.db,
      kysely(database)
        .selectFrom("session_local_mirror_checkpoints")
        .selectAll()
        .where("session_id", "=", sessionId),
    ).rows[0];
    return row ? rowToCheckpoint(row) : undefined;
  });
}

/** Every thread this device has mirrored into the agent: the cursors a reconnect must replay from. */
export function listLocalSessionMirrorCheckpoints(
  scope: SessionAccessScope,
  params: { deviceId: string },
): LocalSessionMirrorCheckpoint[] {
  return read(scope, [], (database) =>
    executeSqliteQuerySync(
      database.db,
      kysely(database)
        .selectFrom("session_local_mirror_checkpoints")
        .selectAll()
        .where("device_id", "=", params.deviceId),
    ).rows.map(rowToCheckpoint),
  );
}

/** Advance the replay cursor; never moves backwards so a late duplicate batch is harmless. */
export function advanceLocalSessionMirrorCheckpoint(
  scope: SessionAccessScope,
  checkpoint: Omit<LocalSessionMirrorCheckpoint, "updatedAt">,
): void {
  const now = Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const db = kysely(database);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_local_mirror_checkpoints")
          .values({
            session_id: checkpoint.sessionId,
            device_id: checkpoint.deviceId,
            thread_id: checkpoint.threadId,
            accepted_seq: checkpoint.acceptedSeq,
            earliest_seq: checkpoint.earliestSeq ?? null,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("session_id").doUpdateSet((eb) => ({
              accepted_seq: eb.fn("max", [
                eb.ref("session_local_mirror_checkpoints.accepted_seq"),
                eb.val(checkpoint.acceptedSeq),
              ]),
              earliest_seq: checkpoint.earliestSeq ?? null,
              updated_at: now,
            })),
          ),
      );
    },
    toDatabaseOptions(resolveSqliteScope(scope)),
    { operationLabel: "session-local-mirror-checkpoint.advance" },
  );
}

export function recordLocalSessionInput(
  scope: SessionAccessScope,
  input: Omit<LocalSessionInputRecord, "state" | "acceptedAt" | "settledAt">,
): LocalSessionInputRecord {
  const acceptedAt = Date.now();
  const record: LocalSessionInputRecord = { ...input, state: "accepted", acceptedAt };
  runOpenClawAgentWriteTransaction(
    (database) => {
      executeSqliteQuerySync(
        database.db,
        kysely(database)
          .insertInto("session_local_inputs")
          .values({
            input_id: record.inputId,
            session_key: record.sessionKey,
            session_id: record.sessionId,
            sender_profile_id: record.senderProfileId ?? null,
            sender_label: record.senderLabel,
            queue_mode: record.queueMode,
            text: record.text,
            state: "accepted",
            native_ref: null,
            reason: null,
            accepted_at: acceptedAt,
            settled_at: null,
          }),
      );
    },
    toDatabaseOptions(resolveSqliteScope(scope)),
    { operationLabel: "session-local-input.record" },
  );
  return record;
}

/** Settle an input once; a later, weaker outcome never overwrites a terminal one. */
export function settleLocalSessionInput(
  scope: SessionAccessScope,
  params: {
    inputId: string;
    state: Exclude<LocalSessionInputState, "accepted">;
    nativeRef?: string;
    reason?: string;
  },
): LocalSessionInputRecord | undefined {
  const now = Date.now();
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const db = kysely(database);
      const current = executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_local_inputs").selectAll().where("input_id", "=", params.inputId),
      ).rows[0];
      if (!current) {
        return undefined;
      }
      const terminal = current.state === "committed" || current.state === "rejected";
      const patch = terminal
        ? {}
        : {
            state: params.state,
            native_ref: params.nativeRef ?? current.native_ref,
            reason: params.reason ?? null,
            settled_at: now,
          };
      if (!terminal) {
        executeSqliteQuerySync(
          database.db,
          db.updateTable("session_local_inputs").set(patch).where("input_id", "=", params.inputId),
        );
      }
      return rowToInput({ ...current, ...patch });
    },
    toDatabaseOptions(resolveSqliteScope(scope)),
    { operationLabel: "session-local-input.settle" },
  );
}

/** The receipt a retried send must reuse instead of relaying the instruction again. */
export function readLocalSessionInput(
  scope: SessionAccessScope,
  inputId: string,
): LocalSessionInputRecord | undefined {
  return read(scope, undefined, (database) => {
    const row = executeSqliteQuerySync(
      database.db,
      kysely(database)
        .selectFrom("session_local_inputs")
        .selectAll()
        .where("input_id", "=", inputId),
    ).rows[0];
    return row ? rowToInput(row) : undefined;
  });
}
