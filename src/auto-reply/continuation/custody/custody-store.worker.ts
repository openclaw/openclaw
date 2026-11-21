// Continuation custody store: the only SQL owner of `continuation_records`
// (RFC docs/design/continue-work-signal-v2.md §5.4.2-§5.4.3, Q1 = E). Every
// write runs inside one synchronous state write transaction in the shared
// state worker. Each operation validates every precondition before its first
// write, so a refusal commits nothing and a thrown write rolls the whole
// transaction back.
import { deliveryQueueEntriesQuery } from "../../../infra/delivery-queue-sqlite-bound.js";
import { executeSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../../../infra/session-delivery-queue.records.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../../../infra/sqlite-schema-ensure.js";
import { requestSqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import {
  formatContinuationChildRunId,
  type ContinuationSpawnAttempt,
} from "../../../shared/continuation-run-key.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import { tableExists } from "../../../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "../../../state/openclaw-state-feature-schema.js";
import type { WorkerOperationContext } from "../../../state/worker-operation-registry.js";
import { CONTINUATION_SPAWN_FAILURE_PHASES } from "./custody-record-codec.js";
import {
  CONTINUATION_RECORDS_TABLE,
  casCheck,
  commitFacts,
  custodyDb,
  insertRecord,
  LIVE_STATUSES,
  newRecord,
  planPatch,
  readRecord,
  selectRecords,
  validateNewRecord,
  writePlanned,
  writeRecord,
  type Planned,
} from "./custody-store.kernel.js";
import type {
  ContinuationAttemptFailureInput,
  ContinuationClaimResult,
  ContinuationCreateResult,
  ContinuationDeleteResult,
  ContinuationElection,
  ContinuationElectionResult,
  ContinuationPruneResult,
  ContinuationRecord,
  ContinuationRecordQuery,
  ContinuationRecordUpdate,
  ContinuationUpdateResult,
  NewContinuationRecord,
} from "./custody-store.types.js";
import type { ContinuationCustodyWorkerOperations } from "./custody-store.worker-contract.js";
import {
  releaseContinuationPostCompactionInDatabase,
  settleContinuationNoticeInDatabase,
} from "./custody-store.worker-handoffs.js";
/**
 * Creates the canonical first-use table and indexes once per database handle,
 * before the first custody write transaction. Reads never create it.
 */
export const ensureContinuationCustodySchema = createSqliteSchemaEnsurer(
  () =>
    getOpenClawStateFeatureSchemaSql(CONTINUATION_RECORDS_TABLE, {
      endMarker: "  ON continuation_records(status, kind, due_at);\n",
      errorMessage: "Canonical state schema markers are missing for continuation_records",
    }),
  { tables: [CONTINUATION_RECORDS_TABLE] },
);

/**
 * FIFO list in `(created_at, record_id)` order. The first-use table may be
 * absent on reads; presence comes from the handle's admitted schema facts.
 */
export function listContinuationRecordsInDatabase(
  db: EngineConnection,
  query: ContinuationRecordQuery,
): ContinuationRecord[] {
  return tableExists(db, CONTINUATION_RECORDS_TABLE) ? selectRecords(db, query) : [];
}

/**
 * Whether session maintenance must read continuation rows or custody through the state worker.
 * Any pending session delivery qualifies; only the worker's decoder tells which rows are
 * continuation-owned, and the custody projection names live owners.
 */
export function readContinuationMaintenanceStateInDatabase(db: EngineConnection) {
  const pending = deliveryQueueEntriesQuery({ db }, [SESSION_DELIVERY_QUEUE_NAME], "pending");
  return {
    pendingSessionDeliveries: executeSqliteQuerySync(db, pending.limit(1)).rows.length > 0,
    liveCustody: listContinuationRecordsInDatabase(db, { statuses: LIVE_STATUSES }).length > 0,
  };
}

/** Durable create keyed by owner and kind; an existing record ID is never overwritten. */
export function createContinuationRecordInDatabase(
  db: EngineConnection,
  input: NewContinuationRecord,
): ContinuationCreateResult {
  const invalid = validateNewRecord(input);
  if (invalid) {
    throw new Error(`invalid continuation record ${input.recordId}: ${invalid}`);
  }
  const existing = readRecord(db, input.recordId);
  if (existing) {
    return {
      outcome: "exists",
      recordId: input.recordId,
      ...(existing.attachmentId !== undefined ? { attachmentId: existing.attachmentId } : {}),
    };
  }
  const record = newRecord(input);
  insertRecord(db, record);
  return { outcome: "created", record, ...commitFacts(db, [record.ownerSessionKey], []) };
}

/**
 * Revision CAS over one or more records, all or nothing. With several updates
 * this is the rollback write: no owner condition, only exact revisions.
 */
export function updateContinuationRecordsInDatabase(
  db: EngineConnection,
  updates: readonly ContinuationRecordUpdate[],
  now: number,
): ContinuationUpdateResult {
  const planned: Planned[] = [];
  const seen = new Set<string>();
  for (const update of updates) {
    if (seen.has(update.recordId)) {
      return {
        outcome: "invalid_transition",
        recordId: update.recordId,
        reason: "a record may appear once per write",
      };
    }
    seen.add(update.recordId);
    const current = readRecord(db, update.recordId);
    const failure = casCheck(current, update.recordId, update.expectedRevision);
    if (failure || !current) {
      return failure ?? { outcome: "not_found", recordId: update.recordId };
    }
    if (current.ownerSessionKey !== update.ownerSessionKey) {
      return {
        outcome: "invalid_transition",
        recordId: update.recordId,
        reason: "record belongs to another owner",
      };
    }
    const plan = planPatch(current, update.patch, now);
    if ("invalid" in plan) {
      return { outcome: "invalid_transition", recordId: update.recordId, reason: plan.invalid };
    }
    planned.push(plan);
  }
  const facts = writePlanned(db, planned);
  return { outcome: "applied", records: planned.map(({ next }) => next), ...facts };
}

/**
 * Owner-conditioned election replacement (RFC §5.4.3), as at C: reread the
 * owner's live work records, require the caller's snapshot exactly, CAS every
 * superseded parked record, require the new record to be new, then write all
 * of it. Chain identity is not part of the condition (Q5).
 */
export function electContinuationWorkInDatabase(
  db: EngineConnection,
  election: ContinuationElection,
): ContinuationElectionResult {
  const { create, ownerSessionKey } = election;
  if (create.kind !== "work" || create.ownerSessionKey !== ownerSessionKey) {
    throw new Error("continuation election must create a work record for its owner");
  }
  const invalid = validateNewRecord(create);
  if (invalid) {
    throw new Error(`invalid continuation record ${create.recordId}: ${invalid}`);
  }
  const live = new Map(
    selectRecords(db, {
      ownerSessionKey,
      kinds: ["work"],
      statuses: LIVE_STATUSES,
    })
      .filter((record) => record.cancelRequestedAt === undefined)
      .map((record) => [record.recordId, record]),
  );
  const expected = new Map(election.expectedLive.map((entry) => [entry.recordId, entry]));
  if (
    expected.size !== election.expectedLive.length ||
    expected.size !== live.size ||
    [...expected.values()].some((entry) => {
      const current = live.get(entry.recordId);
      return current?.revision !== entry.revision || current.status !== entry.status;
    })
  ) {
    return { outcome: "owner_changed", ownerSessionKey };
  }
  const planned: Planned[] = [];
  for (const prior of election.supersede) {
    const current = live.get(prior.recordId);
    if (
      !current ||
      current.status !== "queued" ||
      planned.some(({ next }) => next.recordId === prior.recordId)
    ) {
      return { outcome: "invalid_prior", recordId: prior.recordId };
    }
    const failure = casCheck(current, prior.recordId, prior.expectedRevision);
    if (failure) {
      return failure;
    }
    const plan = planPatch(
      current,
      {
        status: "succeeded",
        phase: prior.phase,
        failureReason: null,
        stateJson: prior.stateJson,
        updatedAt: election.now,
      },
      election.now,
    );
    if ("invalid" in plan) {
      return { outcome: "invalid_prior", recordId: prior.recordId };
    }
    planned.push(plan);
  }
  if (readRecord(db, create.recordId)) {
    return { outcome: "exists", recordId: create.recordId };
  }
  // Supersede first, then insert: a fault between them must roll both back.
  for (const { next, expectedRevision } of planned) {
    writeRecord(db, next, expectedRevision);
  }
  const created = newRecord(create);
  insertRecord(db, created);
  return {
    outcome: "elected",
    created,
    superseded: planned.map(({ next }) => next),
    ...commitFacts(
      db,
      [ownerSessionKey],
      [],
      planned.flatMap(({ ended }) => (ended ? [ended] : [])),
    ),
  };
}

/**
 * Claim a queued delegate for a spawn attempt. The attempt ID is the next
 * integer after every recorded attempt, so IDs are strictly increasing and
 * never reused, and the child run ID comes only from the shared run-key formatter.
 */
export function claimContinuationSpawnAttemptInDatabase(
  db: EngineConnection,
  input: { recordId: string; expectedRevision: number; now: number },
): ContinuationClaimResult {
  const current = readRecord(db, input.recordId);
  const failure = casCheck(current, input.recordId, input.expectedRevision);
  if (failure || !current) {
    return failure ?? { outcome: "not_found", recordId: input.recordId };
  }
  const refuse = (reason: string): ContinuationClaimResult => ({
    outcome: "not_claimable",
    recordId: input.recordId,
    reason,
  });
  if (current.kind !== "delegate") {
    return refuse("only delegate records carry spawn attempts");
  }
  if (current.status !== "queued") {
    return refuse(`status is ${current.status}`);
  }
  if (current.cancelRequestedAt !== undefined) {
    return refuse("cancel requested");
  }
  if (current.handoff) {
    return refuse("already handed off");
  }
  const attemptId =
    current.spawnAttempts.reduce((highest, attempt) => Math.max(highest, attempt.attemptId), 0) + 1;
  const childRunId = formatContinuationChildRunId(current.recordId, attemptId);
  if (current.spawnAttempts.some((attempt) => attempt.childRunId === childRunId)) {
    return refuse("child run id already recorded");
  }
  const attempt: ContinuationSpawnAttempt = { attemptId, childRunId, claimedAt: input.now };
  const plan = planPatch(current, { status: "running" }, input.now);
  if ("invalid" in plan) {
    return refuse(plan.invalid);
  }
  const record = { ...plan.next, spawnAttempts: [...current.spawnAttempts, attempt] };
  const facts = writePlanned(db, [{ ...plan, next: record }]);
  return { outcome: "claimed", record, attempt, ...facts };
}

/** Record the phase in which the latest spawn attempt failed, with an optional CAS patch. */
export function recordContinuationSpawnAttemptFailureInDatabase(
  db: EngineConnection,
  input: ContinuationAttemptFailureInput,
  now: number,
): ContinuationUpdateResult {
  const current = readRecord(db, input.recordId);
  const failure = casCheck(current, input.recordId, input.expectedRevision);
  if (failure || !current) {
    return failure ?? { outcome: "not_found", recordId: input.recordId };
  }
  const latest = current.spawnAttempts.at(-1);
  const invalid = (reason: string): ContinuationUpdateResult => ({
    outcome: "invalid_transition",
    recordId: input.recordId,
    reason,
  });
  if (!CONTINUATION_SPAWN_FAILURE_PHASES.has(input.failurePhase)) {
    return invalid("unknown spawn failure phase");
  }
  if (current.status !== "running" || latest?.attemptId !== input.attemptId) {
    return invalid("only the running record's latest attempt can fail");
  }
  if (latest.failurePhase !== undefined) {
    return invalid("attempt failure already recorded");
  }
  const plan = planPatch(current, input.patch ?? {}, now);
  if ("invalid" in plan) {
    return invalid(plan.invalid);
  }
  const record = {
    ...plan.next,
    spawnAttempts: [
      ...current.spawnAttempts.slice(0, -1),
      { ...latest, failurePhase: input.failurePhase },
    ],
  };
  const facts = writePlanned(db, [{ ...plan, next: record }]);
  return { outcome: "applied", records: [record], ...facts };
}

/**
 * Remove one record at an exact revision (an unaccepted delegate, RFC §5.4.8
 * item 4). A handed-off record was accepted; deleting it would free its ID
 * for a create that reopens the custody the handoff moved away.
 */
export function deleteContinuationRecordInDatabase(
  db: EngineConnection,
  input: { recordId: string; expectedRevision: number },
): ContinuationDeleteResult {
  const current = readRecord(db, input.recordId);
  const failure = casCheck(current, input.recordId, input.expectedRevision);
  if (failure || !current) {
    return failure ?? { outcome: "not_found", recordId: input.recordId };
  }
  if (current.handoff) {
    return {
      outcome: "invalid_transition",
      recordId: input.recordId,
      reason: "a handed-off record cannot be deleted",
    };
  }
  executeSqliteQuerySync(
    db,
    custodyDb(db)
      .deleteFrom(CONTINUATION_RECORDS_TABLE)
      .where("record_id", "=", input.recordId)
      .where("revision", "=", input.expectedRevision),
  );
  return {
    outcome: "deleted",
    recordId: input.recordId,
    ...commitFacts(
      db,
      [current.ownerSessionKey],
      current.attachmentId
        ? [{ recordId: current.recordId, attachmentId: current.attachmentId }]
        : [],
    ),
  };
}

/** Retention: terminal records end after the cutoff unless a notice obligation is pending. */
export function pruneContinuationRecordsInDatabase(
  db: EngineConnection,
  input: { endedBefore: number },
): ContinuationPruneResult {
  if (!tableExists(db, CONTINUATION_RECORDS_TABLE)) {
    return { deletedRecordIds: [] };
  }
  const deleted = executeSqliteQuerySync(
    db,
    custodyDb(db)
      .deleteFrom(CONTINUATION_RECORDS_TABLE)
      .where("status", "in", ["succeeded", "failed", "cancelled"])
      .where("ended_at", "<", input.endedBefore)
      .where("terminal_notice_pending", "is", null)
      .returning("record_id"),
  ).rows;
  return { deletedRecordIds: deleted.map((row) => row.record_id).toSorted() };
}

/** Commands that read or delete only, so they never create the first-use table. */
const SCHEMALESS_COMMANDS: ReadonlySet<keyof ContinuationCustodyWorkerOperations> = new Set<
  keyof ContinuationCustodyWorkerOperations
>(["continuationCustody.list", "continuationCustody.prune", "continuationCustody.readBootFacts"]);

type ContinuationCustodyOperationHandlers = {
  [Type in keyof ContinuationCustodyWorkerOperations]: (
    input: ContinuationCustodyWorkerOperations[Type]["input"],
    context: WorkerOperationContext,
  ) => ContinuationCustodyWorkerOperations[Type]["output"];
};

/** One custody command is one state write transaction in the shared state worker. */
function runCustodyCommand<Result>(
  type: keyof ContinuationCustodyWorkerOperations,
  { open, stateOptions }: WorkerOperationContext,
  apply: (database: OpenClawStateDatabase) => Result,
): Result {
  return runOpenClawStateWriteTransaction(
    (database) => {
      if (!SCHEMALESS_COMMANDS.has(type)) {
        ensureContinuationCustodySchema(database.db);
      }
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = apply(database);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database: open(), ...stateOptions() },
  );
}

/** The shared-state worker's `continuationCustody` domain (openclaw-state-worker-registry.ts). */
export const continuationCustodyOperations: ContinuationCustodyOperationHandlers = {
  "continuationCustody.create": (input, context) =>
    runCustodyCommand("continuationCustody.create", context, ({ db }) =>
      createContinuationRecordInDatabase(db, input.record),
    ),
  "continuationCustody.update": (input, context) =>
    runCustodyCommand("continuationCustody.update", context, ({ db }) =>
      updateContinuationRecordsInDatabase(db, input.updates, input.now),
    ),
  "continuationCustody.elect": (input, context) =>
    runCustodyCommand("continuationCustody.elect", context, ({ db }) =>
      electContinuationWorkInDatabase(db, input),
    ),
  "continuationCustody.claimSpawnAttempt": (input, context) =>
    runCustodyCommand("continuationCustody.claimSpawnAttempt", context, ({ db }) =>
      claimContinuationSpawnAttemptInDatabase(db, input),
    ),
  "continuationCustody.recordSpawnAttemptFailure": (input, context) =>
    runCustodyCommand("continuationCustody.recordSpawnAttemptFailure", context, ({ db }) =>
      recordContinuationSpawnAttemptFailureInDatabase(db, input, input.now),
    ),
  "continuationCustody.delete": (input, context) =>
    runCustodyCommand("continuationCustody.delete", context, ({ db }) =>
      deleteContinuationRecordInDatabase(db, input),
    ),
  "continuationCustody.prune": (input, context) =>
    runCustodyCommand("continuationCustody.prune", context, ({ db }) =>
      pruneContinuationRecordsInDatabase(db, input),
    ),
  "continuationCustody.settleNotice": (input, context) =>
    runCustodyCommand("continuationCustody.settleNotice", context, (database) =>
      settleContinuationNoticeInDatabase(database, input),
    ),
  "continuationCustody.releasePostCompaction": (input, context) =>
    runCustodyCommand("continuationCustody.releasePostCompaction", context, (database) =>
      releaseContinuationPostCompactionInDatabase(database, input),
    ),
  // Recovery and projection hydration read inside the write FIFO so they
  // observe every earlier committed custody write.
  "continuationCustody.list": (input, context) =>
    runCustodyCommand("continuationCustody.list", context, ({ db }) =>
      listContinuationRecordsInDatabase(db, input),
    ),
  "continuationCustody.readBootFacts": (_input, context) =>
    runCustodyCommand("continuationCustody.readBootFacts", context, ({ db }) => ({
      live: listContinuationRecordsInDatabase(db, { statuses: ["queued", "running"] }),
    })),
};
