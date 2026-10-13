import { MessagePort, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import { currentSqliteOperationTiming } from "./sqlite-reader-lifecycle.js";
import {
  SqliteWorkerAdmissionTimeoutError,
  SqliteWorkerError,
  type SqliteWorkerAdmissionRequest,
} from "./sqlite-worker-contract.js";
import { SQLITE_COLD_ADMISSION_PENDING } from "./sqlite-worker-database-admission-relay.js";
import {
  currentSqliteWorkerOperationAdmission as currentAdmission,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-settlement.js";
import {
  readSqliteWorkerRequestCustody,
  type SqliteWorkerRequestCustodyDescriptor,
} from "./sqlite-worker-request-custody.js";
import type { SqliteWriterAdmissionConnection } from "./sqlite-writer-admission-contract.js";

/** This checks broker custody only; other authority owners and final COMMIT remain required. */
export function assertSqliteWriterBrokerAdmission(
  connection: SqliteWriterAdmissionConnection,
  custody: SqliteWorkerRequestCustodyDescriptor,
): void {
  const current = () =>
    Atomics.load(connection.lifetime, 0) === 1 && readSqliteWorkerRequestCustody(custody);
  if (!current()) {
    throw new SqliteWorkerError("SQLite broker admission is revoked", "closed");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = process.hrtime.bigint() + 30_000_000_000n;
  connection.port.postMessage({ custody, decision }, []);
  while (Atomics.load(decision, 0) === 0) {
    const remainingMs = Number(deadline - process.hrtime.bigint()) / 1e6;
    if (remainingMs <= 0) {
      // A late service reply cannot turn an expired request into a grant.
      Atomics.compareExchange(decision, 0, 0, 3);
    } else {
      Atomics.wait(decision, 0, 0, remainingMs);
    }
  }
  const result = Atomics.load(decision, 0);
  if (result === 3) {
    throw new SqliteWorkerAdmissionTimeoutError();
  }
  if (result !== 1 || !current()) {
    throw new SqliteWorkerError("SQLite broker admission is revoked", "closed");
  }
}

const REQUESTED = 0;
const GRANTED = 1;
const TIMED_OUT = 3;

function assertRequestCustody(owner: SqliteWorkerOperationContext): void {
  if (owner.requestCustody && !readSqliteWorkerRequestCustody(owner.requestCustody)) {
    const refusal = new SqliteWorkerError("SQLite worker request custody is revoked", "closed");
    owner.refusal = refusal;
    throw refusal;
  }
}

/** Ask the live host owner for a native stage; preparation precedes writer-lock acquisition. */
export function requestSqliteWorkerOperationAdmission(
  request: SqliteWorkerAdmissionRequest,
  transferList: Transferable[] = [],
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  if (scope.owner.sourceReservations) {
    throw new SqliteWorkerError("SQLite source reservations prohibit host admission", "closed");
  }
  assertRequestCustody(scope.owner);
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const startedAt = Date.now();
  const deadlineNs =
    request.deadlineMs === undefined
      ? undefined
      : process.hrtime.bigint() + BigInt(request.deadlineMs) * 1_000_000n;
  scope.port.postMessage(
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
      deadlineNs === undefined ? undefined : Number(deadlineNs - process.hrtime.bigint()) / 1e6;
    if (remainingMs !== undefined && remainingMs <= 0) {
      Atomics.compareExchange(decision, 0, REQUESTED, TIMED_OUT);
    } else {
      Atomics.wait(decision, 0, REQUESTED, remainingMs);
    }
  }
  const timing = currentSqliteOperationTiming();
  if (timing) {
    timing.hostAdmissionWaitMs += Date.now() - startedAt;
  }
  const outcome = Atomics.load(decision, 0);
  if (
    outcome === SQLITE_COLD_ADMISSION_PENDING &&
    request.stage === "prepare" &&
    isRecord(request.facts) &&
    request.facts.kind === "schema-maintenance" &&
    typeof request.facts.databasePath === "string"
  ) {
    const databasePath = request.facts.databasePath;
    throw new StateDatabaseAdmissionPendingError(
      databasePath,
      `OpenClaw state at ${databasePath} is undergoing schema admission; retry when it finishes.`,
    );
  }
  if (outcome !== GRANTED) {
    const refusal =
      outcome === TIMED_OUT
        ? new SqliteWorkerAdmissionTimeoutError()
        : new SqliteWorkerError("SQLite transaction admission was refused", "closed");
    scope.owner.refusal = refusal;
    throw refusal;
  }
  assertRequestCustody(scope.owner);
}
