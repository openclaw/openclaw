import { MessagePort, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { currentSqliteOperationTiming } from "./sqlite-reader-lifecycle.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
};

type SqliteWorkerAdmissionMessage = SqliteWorkerAdmissionRequest & {
  decision: SharedArrayBuffer;
  deadlineNs?: unknown;
  ports?: unknown;
};

export function isSqliteWorkerAdmissionMessage(
  message: unknown,
): message is SqliteWorkerAdmissionMessage {
  return (
    isRecord(message) &&
    message.decision instanceof SharedArrayBuffer &&
    message.decision.byteLength === Int32Array.BYTES_PER_ELEMENT &&
    (message.stage === "open" ||
      message.stage === "prepare" ||
      message.stage === "transaction" ||
      message.stage === "commit")
  );
}

export const REQUESTED = 0;
export const GRANTED = 1;
export const REFUSED = 2;
const TIMED_OUT = 3;
// Two cron handshakes leave 3s of the other writers' 5s busy budget for SQL and rollback.
const TRANSACTION_ADMISSION_TIMEOUT_MS = 1_000;

export const SqliteWorkerAdmissionTimeoutError = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerAdmissionTimeoutError"),
  () =>
    class AdmissionTimeoutError extends Error {
      // Broker overload certifies non-execution; a timeout rolls back only its current transaction.
      readonly code = "admission-timeout";

      constructor() {
        super("SQLite host admission timed out; retry after transaction rollback");
        this.name = "SqliteWorkerAdmissionTimeoutError";
      }
    },
);

export function expireSqliteWorkerAdmissionDecision(
  decision: Int32Array,
  message: SqliteWorkerAdmissionMessage,
): boolean {
  if (typeof message.deadlineNs === "bigint" && process.hrtime.bigint() >= message.deadlineNs) {
    if (Atomics.compareExchange(decision, 0, REQUESTED, TIMED_OUT) === REQUESTED) {
      Atomics.notify(decision, 0);
    }
  }
  if (Atomics.load(decision, 0) !== TIMED_OUT) {
    return false;
  }
  if (Array.isArray(message.ports)) {
    for (const port of message.ports) {
      if (port instanceof MessagePort) {
        port.close();
      }
    }
  }
  return true;
}

/** The worker's cancellation and host's grant compete for the same atomic decision. */
export function requestSqliteWorkerAdmissionDecision(
  port: MessagePort,
  request: SqliteWorkerAdmissionRequest,
  transferList: Transferable[],
): SqliteWorkerError | InstanceType<typeof SqliteWorkerAdmissionTimeoutError> | undefined {
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const startedAt = Date.now();
  const deadlineNs =
    request.stage === "transaction" || request.stage === "commit"
      ? process.hrtime.bigint() + BigInt(TRANSACTION_ADMISSION_TIMEOUT_MS) * 1_000_000n
      : undefined;
  port.postMessage(
    {
      ...request,
      decision: decision.buffer,
      deadlineNs,
      ports: transferList.filter((value) => value instanceof MessagePort),
    },
    transferList,
  );
  // Cancellation revokes this request, never grants authority. Settlement still
  // joins native rollback before the broker releases operation custody.
  while (Atomics.load(decision, 0) === REQUESTED) {
    const remainingMs =
      deadlineNs === undefined ? Infinity : Number(deadlineNs - process.hrtime.bigint()) / 1e6;
    if (remainingMs <= 0) {
      Atomics.compareExchange(decision, 0, REQUESTED, TIMED_OUT);
    } else {
      Atomics.wait(decision, 0, REQUESTED, remainingMs);
    }
  }
  const timing = currentSqliteOperationTiming();
  if (timing) {
    timing.hostAdmissionWaitMs += Date.now() - startedAt;
  }
  if (Atomics.load(decision, 0) !== GRANTED) {
    return Atomics.load(decision, 0) === TIMED_OUT
      ? new SqliteWorkerAdmissionTimeoutError()
      : new SqliteWorkerError("SQLite transaction admission was refused", "closed");
  }
  return undefined;
}
