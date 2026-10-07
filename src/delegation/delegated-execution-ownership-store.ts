/**
 * Durable storage for the delegated execution ownership registry.
 *
 * Every mutation is a transactional compare-and-swap over the exact
 * delegation_ref, the expected current state, the expected revision, and the
 * exact owner binding. There is no last-write-wins path.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE,
  DELEGATED_EXECUTION_OWNERSHIP_TABLE,
} from "./delegated-execution-ownership.schema.js";
import type {
  DelegatedExecutionOwnershipActorKind,
  DelegatedExecutionOwnershipConflictReason,
  DelegatedExecutionOwnershipEvent,
  DelegatedExecutionOwnershipOwnerState,
  DelegatedExecutionOwnershipRecord,
  DelegatedExecutionOwnershipState,
  DelegatedExecutionOwnershipTerminalEvent,
} from "./delegated-execution-ownership.types.js";

type RegistryDatabase = Pick<
  DB,
  "delegated_execution_ownership" | "delegated_execution_ownership_events"
>;

type OwnershipRow = {
  delegation_ref: string;
  state: string;
  revision: number;
  owner_kind: string;
  owner_id: string;
  owner_state: string;
  delegate_goal_ref: string | null;
  task_scope_ref: string;
  lineage_ref: string | null;
  context_id: string | null;
  execution_id: string | null;
  run_id: string | null;
  enforcement_floor: number;
  authority_ref: string | null;
  created_at: number;
  updated_at: number;
  released_at: number | null;
  release_event: string | null;
  last_event: string;
};

function registryDb(db: DatabaseSync) {
  return getNodeSqliteKysely<RegistryDatabase>(db);
}

export function ownershipRecordFromRow(row: OwnershipRow): DelegatedExecutionOwnershipRecord {
  return Object.freeze({
    delegationRef: row.delegation_ref,
    state: row.state as DelegatedExecutionOwnershipState,
    revision: Number(row.revision),
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    ownerState: row.owner_state as DelegatedExecutionOwnershipOwnerState,
    delegateGoalRef: row.delegate_goal_ref,
    taskScopeRef: row.task_scope_ref,
    lineageRef: row.lineage_ref,
    contextId: row.context_id,
    executionId: row.execution_id,
    runId: row.run_id,
    enforcementFloor: Number(row.enforcement_floor),
    authorityRef: row.authority_ref,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    releasedAt: row.released_at === null ? null : Number(row.released_at),
    releaseEvent: (row.release_event as DelegatedExecutionOwnershipTerminalEvent | null) ?? null,
    lastEvent: row.last_event as DelegatedExecutionOwnershipEvent,
  });
}

export function readOwnershipRow(
  db: DatabaseSync,
  delegationRef: string,
): DelegatedExecutionOwnershipRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    registryDb(db)
      .selectFrom(DELEGATED_EXECUTION_OWNERSHIP_TABLE)
      .selectAll()
      .where("delegation_ref", "=", delegationRef),
  );
  return row ? ownershipRecordFromRow(row as OwnershipRow) : undefined;
}

/** Rows that still reserve delegated work and therefore deny ordinary execution. */
export function listLiveOwnershipRows(db: DatabaseSync): DelegatedExecutionOwnershipRecord[] {
  const rows = executeSqliteQuerySync(
    db,
    registryDb(db)
      .selectFrom(DELEGATED_EXECUTION_OWNERSHIP_TABLE)
      .selectAll()
      .where("state", "in", ["DELEGATED_LOCKED", "FALLBACK_AUTHORIZED"])
      .orderBy("created_at", "asc")
      .orderBy("delegation_ref", "asc"),
  ).rows as OwnershipRow[];
  return rows.map(ownershipRecordFromRow);
}

export function countLiveOwnershipRows(db: DatabaseSync): number {
  const rows = executeSqliteQuerySync(
    db,
    registryDb(db)
      .selectFrom(DELEGATED_EXECUTION_OWNERSHIP_TABLE)
      .select(({ fn }) => fn.countAll<number>().as("live"))
      .where("state", "in", ["DELEGATED_LOCKED", "FALLBACK_AUTHORIZED"]),
  ).rows as Array<{ live: number }>;
  return Number(rows[0]?.live ?? 0);
}

export type OwnershipAcquisitionWrite = {
  delegationRef: string;
  ownerKind: string;
  ownerId: string;
  ownerState: DelegatedExecutionOwnershipOwnerState;
  delegateGoalRef: string | null;
  taskScopeRef: string;
  lineageRef: string | null;
  contextId: string | null;
  executionId: string | null;
  runId: string | null;
  enforcementFloor: number;
  now: number;
};

/**
 * Commits the DELEGATED_LOCKED row before any delegate handoff is attempted.
 * A duplicate delegation_ref never overwrites retained ownership.
 */
export function insertOwnershipRow(
  db: DatabaseSync,
  write: OwnershipAcquisitionWrite,
): "inserted" | "duplicate" {
  const result = executeSqliteQuerySync(
    db,
    registryDb(db)
      .insertInto(DELEGATED_EXECUTION_OWNERSHIP_TABLE)
      .values({
        delegation_ref: write.delegationRef,
        state: "DELEGATED_LOCKED",
        revision: 1,
        owner_kind: write.ownerKind,
        owner_id: write.ownerId,
        owner_state: write.ownerState,
        delegate_goal_ref: write.delegateGoalRef,
        task_scope_ref: write.taskScopeRef,
        lineage_ref: write.lineageRef,
        context_id: write.contextId,
        execution_id: write.executionId,
        run_id: write.runId,
        enforcement_floor: write.enforcementFloor,
        authority_ref: null,
        created_at: write.now,
        updated_at: write.now,
        released_at: null,
        release_event: null,
        last_event: "DELEGATION_ESTABLISHED",
      })
      .onConflict((conflict) => conflict.column("delegation_ref").doNothing()),
  );
  return Number(result.numAffectedRows ?? 0n) === 1 ? "inserted" : "duplicate";
}

export type OwnershipCasWrite = {
  delegationRef: string;
  expectedState: DelegatedExecutionOwnershipState;
  expectedRevision: number;
  expectedOwnerKind: string;
  expectedOwnerId: string;
  next: {
    state: DelegatedExecutionOwnershipState;
    ownerState: DelegatedExecutionOwnershipOwnerState;
    delegateGoalRef?: string | null;
    contextId?: string | null;
    executionId?: string | null;
    runId?: string | null;
    authorityRef: string | null;
    lastEvent: DelegatedExecutionOwnershipEvent;
    releaseEvent: DelegatedExecutionOwnershipTerminalEvent | null;
  };
  now: number;
};

export type OwnershipCasOutcome =
  | { kind: "applied"; record: DelegatedExecutionOwnershipRecord }
  | { kind: "idempotent"; record: DelegatedExecutionOwnershipRecord }
  | {
      kind: "conflict";
      reason: DelegatedExecutionOwnershipConflictReason;
      record: DelegatedExecutionOwnershipRecord | undefined;
    };

/**
 * Applies one closed transition if and only if the retained row still matches
 * the caller's exact expectation. Repeated identical terminal releases are
 * idempotent; any other disagreement is a typed conflict.
 */
export function casOwnershipRow(db: DatabaseSync, write: OwnershipCasWrite): OwnershipCasOutcome {
  const current = readOwnershipRow(db, write.delegationRef);
  if (!current) {
    return { kind: "conflict", reason: "ref-mismatch", record: undefined };
  }
  if (current.state === "RELEASED") {
    return current.lastEvent === write.next.lastEvent &&
      current.releaseEvent === write.next.releaseEvent
      ? { kind: "idempotent", record: current }
      : { kind: "conflict", reason: "unexpected-state", record: current };
  }
  if (current.ownerKind !== write.expectedOwnerKind || current.ownerId !== write.expectedOwnerId) {
    return { kind: "conflict", reason: "actor-mismatch", record: current };
  }
  if (current.revision !== write.expectedRevision) {
    return { kind: "conflict", reason: "stale-revision", record: current };
  }
  if (current.state !== write.expectedState) {
    return { kind: "conflict", reason: "unexpected-state", record: current };
  }
  const nextRevision = current.revision + 1;
  const result = executeSqliteQuerySync(
    db,
    registryDb(db)
      .updateTable(DELEGATED_EXECUTION_OWNERSHIP_TABLE)
      .set({
        state: write.next.state,
        revision: nextRevision,
        owner_state: write.next.ownerState,
        delegate_goal_ref:
          write.next.delegateGoalRef === undefined
            ? current.delegateGoalRef
            : write.next.delegateGoalRef,
        context_id: write.next.contextId === undefined ? current.contextId : write.next.contextId,
        execution_id:
          write.next.executionId === undefined ? current.executionId : write.next.executionId,
        run_id: write.next.runId === undefined ? current.runId : write.next.runId,
        authority_ref: write.next.authorityRef,
        updated_at: write.now,
        released_at: write.next.releaseEvent === null ? null : write.now,
        release_event: write.next.releaseEvent,
        last_event: write.next.lastEvent,
      })
      .where("delegation_ref", "=", write.delegationRef)
      .where("state", "=", write.expectedState)
      .where("revision", "=", write.expectedRevision),
  );
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    return {
      kind: "conflict",
      reason: "stale-revision",
      record: readOwnershipRow(db, write.delegationRef),
    };
  }
  const record = readOwnershipRow(db, write.delegationRef);
  if (!record) {
    return { kind: "conflict", reason: "ref-mismatch", record: undefined };
  }
  return { kind: "applied", record };
}

export type OwnershipEventWrite = {
  eventId: string;
  delegationRef: string;
  event: DelegatedExecutionOwnershipEvent;
  fromState: DelegatedExecutionOwnershipState | null;
  toState: DelegatedExecutionOwnershipState;
  revision: number;
  actorKind: DelegatedExecutionOwnershipActorKind;
  actorRef: string;
  authorityRef: string | null;
  occurredAt: number;
  detail: unknown;
};

export function appendOwnershipEvent(db: DatabaseSync, write: OwnershipEventWrite): void {
  executeSqliteQuerySync(
    db,
    registryDb(db)
      .insertInto(DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE)
      .values({
        event_id: write.eventId,
        delegation_ref: write.delegationRef,
        event: write.event,
        from_state: write.fromState,
        to_state: write.toState,
        revision: write.revision,
        actor_kind: write.actorKind,
        actor_ref: write.actorRef,
        authority_ref: write.authorityRef,
        occurred_at: write.occurredAt,
        detail_json: JSON.stringify(write.detail ?? {}),
      })
      .onConflict((conflict) => conflict.column("event_id").doNothing()),
  );
}

export type OwnershipEventRow = {
  event_id: string;
  delegation_ref: string;
  event: string;
  from_state: string | null;
  to_state: string;
  revision: number;
  actor_kind: string;
  actor_ref: string;
  authority_ref: string | null;
  occurred_at: number;
  detail_json: string;
};

export function listOwnershipEvents(db: DatabaseSync, delegationRef: string): OwnershipEventRow[] {
  return executeSqliteQuerySync(
    db,
    registryDb(db)
      .selectFrom(DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE)
      .selectAll()
      .where("delegation_ref", "=", delegationRef)
      .orderBy("occurred_at", "asc")
      .orderBy("event_id", "asc"),
  ).rows as OwnershipEventRow[];
}

export function listAllOwnershipRows(db: DatabaseSync): DelegatedExecutionOwnershipRecord[] {
  const rows = executeSqliteQuerySync(
    db,
    registryDb(db)
      .selectFrom(DELEGATED_EXECUTION_OWNERSHIP_TABLE)
      .selectAll()
      .orderBy("created_at", "asc")
      .orderBy("delegation_ref", "asc"),
  ).rows as OwnershipRow[];
  return rows.map(ownershipRecordFromRow);
}
