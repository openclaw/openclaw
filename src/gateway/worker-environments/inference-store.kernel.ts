import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as StateDatabase,
  WorkerInferenceTurns,
} from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerInferenceTurnInput,
  WorkerInferenceTurnBeginResult,
  WorkerInferenceRetentionPolicy,
} from "./inference-store.types.js";
import { createWorkerLedgerInputValidation } from "./worker-ledger-validation.js";

type InferenceDb = Pick<StateDatabase, "worker_inference_turns"> & {
  pragma_encoding: { encoding: string };
};
type TurnIdentityRow = Pick<
  Selectable<WorkerInferenceTurns>,
  "session_id" | "run_epoch" | "run_id" | "turn_id"
>;

type NormalizedTurnInput = WorkerInferenceTurnInput & { nowMs: number };
type WorkerInferenceTurnIdentity = Pick<
  WorkerInferenceTurnInput,
  "sessionId" | "runEpoch" | "runId" | "turnId"
>;
type ExistingTurnResult = Extract<
  WorkerInferenceTurnBeginResult,
  { kind: "recover" | "replay" | "rejected" }
>;

const {
  required,
  integer: nonNegativeInteger,
  requestHash: normalizeRequestHash,
} = createWorkerLedgerInputValidation("Worker inference turn");
const DEFAULT_RETENTION: WorkerInferenceRetentionPolicy = {
  maxAgeMs: 24 * 60 * 60 * 1_000,
  maxRows: 256,
  maxBytes: 64 * 1024 * 1024,
};

function normalizeInput(input: WorkerInferenceTurnInput, nowMs: number): NormalizedTurnInput {
  return {
    environmentId: required(input.environmentId, "environment id"),
    sessionId: required(input.sessionId, "session id"),
    runEpoch: nonNegativeInteger(input.runEpoch, "run epoch"),
    runId: required(input.runId, "run id"),
    turnId: required(input.turnId, "turn id"),
    requestHash: normalizeRequestHash(input.requestHash),
    nowMs: nonNegativeInteger(nowMs, "timestamp"),
  };
}

function parseTerminalJson(value: string): WorkerInferenceTerminalOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Worker inference cached terminal outcome is invalid", { cause: error });
  }
  if (!validateWorkerInferenceTerminalOutcome(parsed)) {
    throw new Error("Worker inference cached terminal outcome is invalid");
  }
  return parsed;
}

function serializeTerminalOutcome(outcome: WorkerInferenceTerminalOutcome): string {
  if (!validateWorkerInferenceTerminalOutcome(outcome)) {
    throw new Error("Worker inference terminal outcome is invalid");
  }
  const serialized = JSON.stringify(outcome);
  if (!serialized) {
    throw new Error("Worker inference terminal outcome is not serializable");
  }
  return serialized;
}

/** The shared-state worker supplies the already-admitted transaction connection. */
export function createWorkerInferenceStoreKernel(options: {
  db: DatabaseSync;
  now: () => number;
  retention?: Partial<WorkerInferenceRetentionPolicy>;
}) {
  const { db, now } = options;
  const query = getNodeSqliteKysely<InferenceDb>(db);
  const retention = { ...DEFAULT_RETENTION, ...options.retention };
  const terminalUpdate = (terminalJson: string, nowMs: number) =>
    query
      .updateTable("worker_inference_turns")
      .set({ state: "terminal", terminal_json: terminalJson, updated_at_ms: nowMs });

  const classifyTurn = (input: NormalizedTurnInput): ExistingTurnResult | undefined => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_inference_turns")
        .selectAll()
        .where("session_id", "=", input.sessionId)
        .where("run_epoch", "=", input.runEpoch)
        .where("run_id", "=", input.runId)
        .where("turn_id", "=", input.turnId),
    );
    if (!row) {
      return undefined;
    }
    if (row.environment_id !== input.environmentId || row.request_hash !== input.requestHash) {
      return { kind: "rejected", reason: "conflict" };
    }
    if (row.state === "pending" && row.terminal_json === null) {
      return { kind: "recover" };
    }
    if (row.state === "terminal" && row.terminal_json !== null) {
      return { kind: "replay", outcome: parseTerminalJson(row.terminal_json) };
    }
    throw new Error("Worker inference turn row has invalid terminal state");
  };

  const pruneTerminalTurns = (nowMs: number, preserve?: WorkerInferenceTurnIdentity): void => {
    const utf8 =
      executeSqliteQueryTakeFirstSync(db, query.selectFrom("pragma_encoding").select("encoding"))
        ?.encoding === "UTF-8";
    const retained = query
      .selectFrom("worker_inference_turns")
      .select(["session_id", "run_epoch", "run_id", "turn_id", "updated_at_ms"])
      .where("state", "=", "terminal")
      .orderBy("updated_at_ms", "desc")
      .orderBy("session_id", "asc")
      .orderBy("run_epoch", "desc")
      .orderBy("run_id", "asc")
      .orderBy("turn_id", "asc");
    // UTF-8 lengths need no payload reads; UTF-16 stores retain the UTF-8 budget.
    const rows = utf8
      ? executeSqliteQuerySync(
          db,
          retained.select((eb) =>
            eb.fn<number>("octet_length", ["terminal_json"]).as("terminal_bytes"),
          ),
        ).rows
      : executeSqliteQuerySync(db, retained.select("terminal_json")).rows.map((row) => ({
          session_id: row.session_id,
          run_epoch: row.run_epoch,
          run_id: row.run_id,
          turn_id: row.turn_id,
          updated_at_ms: row.updated_at_ms,
          terminal_bytes: Buffer.byteLength(row.terminal_json ?? "", "utf8"),
        }));
    const isPreserved = (row: TurnIdentityRow) =>
      preserve !== undefined &&
      row.session_id === preserve.sessionId &&
      row.run_epoch === preserve.runEpoch &&
      row.run_id === preserve.runId &&
      row.turn_id === preserve.turnId;
    rows.sort((left, right) => Number(isPreserved(right)) - Number(isPreserved(left)));
    const cutoffMs = Math.max(0, nowMs - retention.maxAgeMs);
    let retainedRows = 0;
    let retainedBytes = 0;
    for (const row of rows) {
      const terminalBytes = row.terminal_bytes;
      const preserved = isPreserved(row);
      const expired = row.updated_at_ms < cutoffMs;
      const exceedsRows = retainedRows >= retention.maxRows;
      const exceedsBytes = retainedRows > 0 && retainedBytes + terminalBytes > retention.maxBytes;
      if (!preserved && (expired || exceedsRows || exceedsBytes)) {
        // Expired identities leave the bounded replay window.
        executeSqliteQuerySync(
          db,
          query
            .deleteFrom("worker_inference_turns")
            .where("session_id", "=", row.session_id)
            .where("run_epoch", "=", row.run_epoch)
            .where("run_id", "=", row.run_id)
            .where("turn_id", "=", row.turn_id)
            .where("state", "=", "terminal"),
        );
        continue;
      }
      retainedRows += 1;
      retainedBytes += terminalBytes;
    }
  };

  const begin = (rawInput: WorkerInferenceTurnInput): WorkerInferenceTurnBeginResult => {
    const input = normalizeInput(rawInput, now());
    pruneTerminalTurns(input.nowMs);
    const existing = classifyTurn(input);
    if (existing) {
      return existing;
    }
    if (
      executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("worker_inference_turns")
          .selectAll()
          .where("session_id", "=", input.sessionId)
          .where("run_epoch", "=", input.runEpoch)
          .where("run_id", "=", input.runId)
          .where("state", "=", "pending"),
      )
    ) {
      return { kind: "rejected", reason: "conflict" };
    }
    executeSqliteQuerySync(
      db,
      query.insertInto("worker_inference_turns").values({
        session_id: input.sessionId,
        run_epoch: input.runEpoch,
        run_id: input.runId,
        turn_id: input.turnId,
        environment_id: input.environmentId,
        request_hash: input.requestHash,
        state: "pending",
        terminal_json: null,
        created_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      }),
    );
    return { kind: "claimed" };
  };

  const complete = (
    rawInput: WorkerInferenceTurnInput & { outcome: WorkerInferenceTerminalOutcome },
  ): WorkerInferenceTerminalOutcome => {
    const input = normalizeInput(rawInput, now());
    const terminalJson = serializeTerminalOutcome(rawInput.outcome);
    const existing = classifyTurn(input);
    if (!existing) {
      throw new Error("Worker inference turn must begin before terminal completion");
    }
    if (existing.kind === "rejected") {
      throw new Error(`Worker inference terminal completion rejected: ${existing.reason}`);
    }
    if (existing.kind === "replay") {
      return existing.outcome;
    }

    const update = executeSqliteQuerySync(
      db,
      terminalUpdate(terminalJson, input.nowMs)
        .where("session_id", "=", input.sessionId)
        .where("run_epoch", "=", input.runEpoch)
        .where("run_id", "=", input.runId)
        .where("turn_id", "=", input.turnId)
        .where("environment_id", "=", input.environmentId)
        .where("request_hash", "=", input.requestHash)
        .where("state", "=", "pending"),
    );
    if (update.numAffectedRows !== 1n) {
      throw new Error("Worker inference turn changed during terminal completion");
    }
    pruneTerminalTurns(input.nowMs, input);
    return rawInput.outcome;
  };

  const cancelPending = (
    params: Omit<WorkerInferenceTurnInput, "requestHash"> & {
      outcome: WorkerInferenceTerminalOutcome;
    },
  ): void => {
    const nowMs = nonNegativeInteger(now(), "timestamp");
    const terminalJson = serializeTerminalOutcome(params.outcome);
    const identity = {
      environmentId: required(params.environmentId, "environment id"),
      sessionId: required(params.sessionId, "session id"),
      runEpoch: nonNegativeInteger(params.runEpoch, "run epoch"),
      runId: required(params.runId, "run id"),
      turnId: required(params.turnId, "turn id"),
    };
    executeSqliteQuerySync(
      db,
      terminalUpdate(terminalJson, nowMs)
        .where("session_id", "=", identity.sessionId)
        .where("run_epoch", "=", identity.runEpoch)
        .where("run_id", "=", identity.runId)
        .where("turn_id", "=", identity.turnId)
        .where("environment_id", "=", identity.environmentId)
        .where("state", "=", "pending"),
    );
    pruneTerminalTurns(nowMs, identity);
  };

  const recoverPending = (outcome: WorkerInferenceTerminalOutcome): void => {
    const nowMs = nonNegativeInteger(now(), "timestamp");
    const terminalJson = serializeTerminalOutcome(outcome);
    executeSqliteQuerySync(db, terminalUpdate(terminalJson, nowMs).where("state", "=", "pending"));
    pruneTerminalTurns(nowMs);
  };

  return { begin, cancelPending, complete, recoverPending };
}
