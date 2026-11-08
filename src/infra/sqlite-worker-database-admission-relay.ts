import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-errors.js";
import {
  readSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissions,
} from "./sqlite-database-admission-record.js";
import {
  assertSqliteDatabaseAdmissionWaitActive,
  hasSqliteDatabaseAdmissionWait,
  readSqliteDatabaseAdmissionDeadline,
} from "./sqlite-database-admission-wait.js";
import { currentSqliteOperationTiming } from "./sqlite-reader-lifecycle.js";
import { readSqliteWorkerMonotonicNs, SqliteWorkerError } from "./sqlite-worker-contract.js";

export {
  assertSqliteDatabaseAdmissionWaitActive,
  readSqliteDatabaseAdmissionDeadline,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-database-admission-wait.js";

const REQUESTED = 0;
const GRANTED = 1;
const ABANDONED = 2;
// Slow hosts may legitimately take minutes. This only prevents a vanished peer
// from parking forever: it cannot notify, and close cannot run during Atomics.wait.
const ADMISSION_PEER_SAFETY_TIMEOUT_MS = 10 * 60_000;
export const SQLITE_COLD_ADMISSION_PENDING = 4;

export class SqliteDatabaseAdmissionTimeoutError extends SqliteWorkerError {
  constructor() {
    super("SQLite admission facts exchange timed out; the host did not reply", "unavailable");
  }
}

const admissionUpstream = resolveGlobalSingleton<{
  connection?: { port: MessagePort; closed: boolean };
}>(Symbol.for("openclaw.sqliteDatabaseAdmissionUpstream"), () => ({}));

/** A served worker relays descendant facts through its existing lifetime channel. */
export function bindSqliteDatabaseAdmissionUpstream(port: MessagePort): void {
  const current = admissionUpstream.connection;
  if (current) {
    if (current.port !== port) {
      throw new SqliteWorkerError("SQLite admission upstream changed owner", "closed");
    }
    return;
  }
  const connection = { port, closed: false };
  admissionUpstream.connection = connection;
  port.once("close", () => {
    connection.closed = true;
  });
  port.unref();
}

export function getSqliteDatabaseAdmissionUpstream() {
  return admissionUpstream.connection;
}

/** Format facts use this private channel independently of transaction authority. */
export function exchangeSqliteDatabaseAdmissions(
  port: MessagePort,
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
): SqliteDatabaseAdmissions {
  return exchangeDatabaseAdmissions(port, admissions, location, create);
}

// Only a broker's live captured authority can originate an admitted creation relay.
export function exchangeDatabaseAdmissions(
  port: MessagePort,
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean | "admitted",
): SqliteDatabaseAdmissions {
  const { port1, port2 } = new MessageChannel();
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const timing = currentSqliteOperationTiming();
  const startedAt = Date.now();
  const deadlineAtMs = readSqliteDatabaseAdmissionDeadline();
  const timeoutMs =
    deadlineAtMs === undefined
      ? ADMISSION_PEER_SAFETY_TIMEOUT_MS
      : Math.max(0, deadlineAtMs - Date.now());
  const deadlineNs = readSqliteWorkerMonotonicNs() + BigInt(Math.ceil(timeoutMs)) * 1_000_000n;
  const remaining = () => {
    assertSqliteDatabaseAdmissionWaitActive();
    const remainingMs = Number(deadlineNs - readSqliteWorkerMonotonicNs()) / 1e6;
    if (remainingMs <= 0) {
      throw new SqliteDatabaseAdmissionTimeoutError();
    }
    return remainingMs;
  };
  try {
    remaining();
    port.postMessage(
      {
        kind: "sqlite-database-admissions",
        admissions,
        location,
        create,
        deadlineAtMs,
        port: port2,
        decision: decision.buffer,
      },
      [port2],
    );
    while (Atomics.load(decision, 0) === REQUESTED) {
      const remainingMs = remaining();
      // Caller cancellation can be published through another shared word while this loop is parked.
      Atomics.wait(
        decision,
        0,
        REQUESTED,
        hasSqliteDatabaseAdmissionWait() ? Math.min(100, remainingMs) : remainingMs,
      );
    }
    remaining();
    const outcome = Atomics.load(decision, 0);
    if (outcome === SQLITE_COLD_ADMISSION_PENDING && location && create === true) {
      throw new StateDatabaseAdmissionPendingError(
        location,
        `OpenClaw state at ${location} is undergoing schema admission; retry when it finishes.`,
      );
    }
    if (outcome !== GRANTED) {
      throw new SqliteWorkerError("SQLite admission facts exchange failed", "unavailable");
    }
    // The host posts the registry before publishing the shared completion flag.
    const reply = readSqliteDatabaseAdmissions(receiveMessageOnPort(port1)?.message);
    if (!reply) {
      throw new SqliteWorkerError("SQLite admission facts reply is unavailable", "unavailable");
    }
    return reply;
  } finally {
    // Let an upstream relay observe downstream cancellation while its own event loop is parked.
    Atomics.compareExchange(decision, 0, REQUESTED, ABANDONED);
    if (timing) {
      timing.databaseAdmissionWaitMs += Date.now() - startedAt;
    }
    port1.close();
    port2.close();
  }
}
