import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type {
  DB as StateDatabase,
  WorkerTranscriptCommitHeads,
  WorkerTranscriptCommits,
} from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import {
  isWorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitInput,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitBeginResult,
  type WorkerTranscriptCommitOperations,
} from "./transcript-commit-store.worker-contract.js";
import { createWorkerLedgerInputValidation } from "./worker-ledger-validation.js";

type TranscriptCommitDb = Pick<
  StateDatabase,
  "worker_transcript_commit_heads" | "worker_transcript_commits"
>;
type HeadRow = Selectable<WorkerTranscriptCommitHeads>;
type CommitRow = Selectable<WorkerTranscriptCommits>;

type NormalizedCommitInput = WorkerTranscriptCommitInput & { nowMs: number };
type ExistingCommitResult = Extract<
  WorkerTranscriptCommitBeginResult,
  { kind: "recover" | "replay" | "rejected" }
>;

const { required, integer, requestHash } = createWorkerLedgerInputValidation(
  "Worker transcript commit",
);

function parseOutcomeJson(value: string): WorkerTranscriptCommitOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Worker transcript commit cached outcome is invalid", { cause: error });
  }
  if (isWorkerTranscriptCommitOutcome(parsed)) {
    return parsed.ok ? { ok: true, result: parsed.result } : { ok: false, reason: parsed.reason };
  }
  throw new Error("Worker transcript commit cached outcome is invalid");
}

function normalizeInput(input: WorkerTranscriptCommitInput, nowMs: number): NormalizedCommitInput {
  return {
    environmentId: required(input.environmentId, "environment id"),
    sessionId: required(input.sessionId, "session id"),
    runEpoch: integer(input.runEpoch, "run epoch"),
    seq: integer(input.seq, "sequence", 1),
    requestHash: requestHash(input.requestHash),
    nowMs: integer(nowMs, "timestamp"),
  };
}

const query = (db: DatabaseSync) => getNodeSqliteKysely<TranscriptCommitDb>(db);

function findHead(db: DatabaseSync, input: NormalizedCommitInput): HeadRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commit_heads")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch),
  );
}

function findCommit(db: DatabaseSync, input: NormalizedCommitInput): CommitRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commits")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch)
      .where("seq", "=", input.seq),
  );
}

function classifyExistingCommit(params: {
  head: HeadRow | undefined;
  commit: CommitRow | undefined;
  input: NormalizedCommitInput;
}): ExistingCommitResult | undefined {
  if (!params.commit) {
    return undefined;
  }
  if (!params.head) {
    throw new Error("Worker transcript commit row has no sequence head");
  }
  if (
    params.head.environment_id !== params.input.environmentId ||
    params.commit.request_hash !== params.input.requestHash
  ) {
    return { kind: "rejected", reason: "conflict" };
  }
  if (params.commit.state === "pending") {
    return { kind: "recover" };
  }
  if (params.commit.state === "terminal" && params.commit.result_json !== null) {
    return { kind: "replay", outcome: parseOutcomeJson(params.commit.result_json) };
  }
  throw new Error("Worker transcript commit row has invalid terminal state");
}

function writeTranscriptCommit<T>(
  database: OpenClawStateDatabase,
  operationLabel: string,
  operation: (db: DatabaseSync) => T,
): T {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = operation(db);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: result });
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { database },
    { operationLabel },
  );
}

export const workerTranscriptCommitOperations = {
  "placementTranscript.begin": (
    rawInput: WorkerTranscriptCommitOperations["placementTranscript.begin"]["input"],
    { open },
  ): WorkerTranscriptCommitBeginResult => {
    const database = open();
    const input = normalizeInput(rawInput, rawInput.nowMs);
    return writeTranscriptCommit<WorkerTranscriptCommitBeginResult>(
      database,
      "placementTranscript.begin",
      (db) => {
        const head = findHead(db, input);
        const existing = classifyExistingCommit({ head, commit: findCommit(db, input), input });
        if (existing) {
          return existing;
        }
        if (head && head.environment_id !== input.environmentId) {
          return { kind: "rejected", reason: "conflict" };
        }
        const expectedSeq = head?.next_seq ?? 1;
        if (input.seq !== expectedSeq) {
          return { kind: "rejected", reason: "out-of-order", expectedSeq };
        }
        if (!head) {
          executeSqliteQuerySync(
            db,
            query(db).insertInto("worker_transcript_commit_heads").values({
              session_id: input.sessionId,
              run_epoch: input.runEpoch,
              environment_id: input.environmentId,
              next_seq: 1,
              updated_at_ms: input.nowMs,
            }),
          );
        }
        executeSqliteQuerySync(
          db,
          query(db).insertInto("worker_transcript_commits").values({
            session_id: input.sessionId,
            run_epoch: input.runEpoch,
            seq: input.seq,
            request_hash: input.requestHash,
            state: "pending",
            result_json: null,
            created_at_ms: input.nowMs,
            updated_at_ms: input.nowMs,
          }),
        );
        return { kind: "claimed" };
      },
    );
  },

  "placementTranscript.complete": (
    rawInput: WorkerTranscriptCommitOperations["placementTranscript.complete"]["input"],
    { open },
  ): WorkerTranscriptCommitOutcome => {
    const database = open();
    const input = normalizeInput(rawInput, rawInput.nowMs);
    const resultJson = JSON.stringify(rawInput.outcome);
    return writeTranscriptCommit<WorkerTranscriptCommitOutcome>(
      database,
      "placementTranscript.complete",
      (db) => {
        const head = findHead(db, input);
        const commit = findCommit(db, input);
        const existing = classifyExistingCommit({ head, commit, input });
        if (!existing) {
          throw new Error("Worker transcript commit must begin before terminal completion");
        }
        if (existing.kind === "rejected") {
          throw new Error(
            `Worker transcript commit terminal completion rejected: ${existing.reason}`,
          );
        }
        if (existing.kind === "replay") {
          return existing.outcome;
        }
        if (!head) {
          throw new Error("Worker transcript commit row has no sequence head");
        }
        if (head.next_seq !== input.seq) {
          throw new Error(
            `Worker transcript commit terminal completion expected sequence ${head.next_seq}`,
          );
        }

        const commitUpdate = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_transcript_commits")
            .set({ state: "terminal", result_json: resultJson, updated_at_ms: input.nowMs })
            .where("session_id", "=", input.sessionId)
            .where("run_epoch", "=", input.runEpoch)
            .where("seq", "=", input.seq)
            .where("request_hash", "=", input.requestHash)
            .where("state", "=", "pending"),
        );
        if (commitUpdate.numAffectedRows !== 1n) {
          throw new Error("Worker transcript commit changed during terminal completion");
        }
        const headUpdate = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_transcript_commit_heads")
            .set({ next_seq: input.seq + 1, updated_at_ms: input.nowMs })
            .where("session_id", "=", input.sessionId)
            .where("run_epoch", "=", input.runEpoch)
            .where("environment_id", "=", input.environmentId)
            .where("next_seq", "=", input.seq),
        );
        if (headUpdate.numAffectedRows !== 1n) {
          throw new Error("Worker transcript commit sequence changed during terminal completion");
        }
        return rawInput.outcome;
      },
    );
  },

  // Only the invocation that freshly claimed this row may discard it after a
  // known rollback. Recovered reservations can describe an already committed batch.
  "placementTranscript.discard": (
    rawInput: WorkerTranscriptCommitOperations["placementTranscript.discard"]["input"],
    { open },
  ): true => {
    const database = open();
    const input = normalizeInput(rawInput, rawInput.nowMs);
    return writeTranscriptCommit<true>(database, "placementTranscript.discard", (db) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .deleteFrom("worker_transcript_commits")
          .where("session_id", "=", input.sessionId)
          .where("run_epoch", "=", input.runEpoch)
          .where("seq", "=", input.seq)
          .where("request_hash", "=", input.requestHash)
          .where("state", "=", "pending")
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("worker_transcript_commit_heads")
                .select("session_id")
                .where("session_id", "=", input.sessionId)
                .where("run_epoch", "=", input.runEpoch)
                .where("environment_id", "=", input.environmentId)
                .where("next_seq", "=", input.seq),
            ),
          ),
      );
      return true;
    });
  },
} satisfies WorkerOperationHandlers;
