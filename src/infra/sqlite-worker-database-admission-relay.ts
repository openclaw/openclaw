import type { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort, MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-errors.js";
import { captureSqliteDatabaseAdmissions } from "./sqlite-database-admission-context.js";
import {
  readSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissionCursor,
  type SqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissionLocation,
} from "./sqlite-database-admission-record.js";
import {
  assertSqliteDatabaseAdmissionWaitActive,
  hasSqliteDatabaseAdmissionWait,
  readSqliteDatabaseAdmissionDeadline,
} from "./sqlite-database-admission-wait.js";
import { currentSqliteOperationTiming } from "./sqlite-reader-lifecycle.js";
import { readSqliteWorkerMonotonicNs, SqliteWorkerError } from "./sqlite-worker-contract.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";

export {
  assertSqliteDatabaseAdmissionWaitActive,
  readSqliteDatabaseAdmissionDeadline,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-database-admission-wait.js";

const REQUESTED = 0;
const GRANTED = 1;
const ABANDONED = 2;
const REFUSED = 2;
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

function isSqliteDatabaseAdmissionLocation(
  value: unknown,
): value is SqliteDatabaseAdmissionLocation {
  return (
    isRecord(value) && typeof value.identity === "string" && typeof value.canonicalPath === "string"
  );
}

/** Format facts use this private channel independently of transaction authority. */
export function exchangeSqliteDatabaseAdmissions(
  port: MessagePort,
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean,
  observedLocation?: SqliteDatabaseAdmissionLocation,
): SqliteDatabaseAdmissions {
  return exchangeDatabaseAdmissions(port, admissions, location, create, observedLocation);
}

// Only a broker's live captured authority can originate an admitted creation relay.
export function exchangeDatabaseAdmissions(
  port: MessagePort,
  admissions: SqliteDatabaseAdmissions,
  location?: string,
  create?: boolean | "admitted",
  observedLocation?: SqliteDatabaseAdmissionLocation,
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
        observedLocation,
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

const databaseAdmissionCursors = new WeakMap<
  object,
  { cursor: SqliteDatabaseAdmissionCursor; reset(): SqliteDatabaseAdmissionCursor }
>();

export function bindSqliteWorkerDatabaseAdmissionCursor(
  admission: object,
  cursor: SqliteDatabaseAdmissionCursor,
  reset: () => SqliteDatabaseAdmissionCursor,
): void {
  databaseAdmissionCursors.set(admission, { cursor, reset });
}

type SqliteDatabaseAdmissionMessage = Record<string, unknown> & {
  port: MessagePort;
  decision: SharedArrayBuffer;
  location?: string;
  observedLocation?: SqliteDatabaseAdmissionLocation;
  deadlineAtMs?: number;
  create?: boolean | "admitted";
};

function isSqliteDatabaseAdmissionMessage(
  message: Record<string, unknown>,
): message is SqliteDatabaseAdmissionMessage {
  return !(
    !(message.port instanceof MessagePort) ||
    !(message.decision instanceof SharedArrayBuffer) ||
    message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
    (message.location !== undefined && typeof message.location !== "string") ||
    (message.observedLocation !== undefined &&
      !isSqliteDatabaseAdmissionLocation(message.observedLocation)) ||
    (message.deadlineAtMs !== undefined &&
      (typeof message.deadlineAtMs !== "number" || !Number.isFinite(message.deadlineAtMs))) ||
    (message.create !== undefined &&
      typeof message.create !== "boolean" &&
      message.create !== "admitted")
  );
}

/** Reply framing and publication cursors share the operation port, never its authority. */
export function createSqliteDatabaseAdmissionReplies() {
  let databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor();
  return {
    release(admission: object) {
      databaseAdmissionCursors.delete(admission);
    },
    receive(
      message: Record<string, unknown>,
      admission: object,
      inOwnerContext: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined,
      recordFailure: (error: unknown) => void,
    ) {
      if (!isSqliteDatabaseAdmissionMessage(message)) {
        recordFailure(
          new SqliteWorkerError("SQLite admission facts request is invalid", "unavailable"),
        );
        return undefined;
      }
      const decision = new Int32Array(message.decision);
      const { deadlineAtMs, observedLocation } = message;
      const assertWaiting = () => {
        if (
          Atomics.load(decision, 0) !== REQUESTED ||
          (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs)
        ) {
          throw new SqliteWorkerError("SQLite admission requester stopped waiting", "unavailable");
        }
      };
      const replyPort = message.port;
      const requestedLocation = message.location;
      const publishFacts = (
        admissions: NonNullable<ReturnType<typeof readSqliteDatabaseAdmissions>>,
      ) => {
        assertWaiting();
        const scope =
          requestedLocation === undefined && admissions.length === 0
            ? undefined
            : { location: requestedLocation, admissions };
        const cursor = databaseAdmissionCursors.get(admission);
        const reply = captureSqliteDatabaseAdmissions(
          cursor?.cursor ?? databaseAdmissionCursor,
          scope,
        );
        replyPort.postMessage(reply, []);
        recordWorkerMessage("admission", "to_worker");
        Atomics.compareExchange(decision, 0, REQUESTED, GRANTED);
      };
      const failFacts = (error: unknown, coldOpenPath: string | undefined) => {
        if (Atomics.load(decision, 0) !== REQUESTED) {
          return;
        }
        const cursor = databaseAdmissionCursors.get(admission);
        if (cursor) {
          cursor.cursor = inOwnerContext ? inOwnerContext(() => cursor.reset()) : cursor.reset();
        } else {
          databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor();
        }
        if (
          error instanceof StateDatabaseAdmissionPendingError &&
          error.databasePath === coldOpenPath
        ) {
          Atomics.compareExchange(decision, 0, REQUESTED, SQLITE_COLD_ADMISSION_PENDING);
        } else if (Atomics.compareExchange(decision, 0, REQUESTED, REFUSED) === REQUESTED) {
          recordFailure(error);
        }
      };
      const finishFacts = () => {
        replyPort.close();
        Atomics.notify(decision, 0);
      };
      return {
        message,
        decision,
        deadlineAtMs,
        observedLocation,
        assertWaiting,
        publishFacts,
        failFacts,
        finishFacts,
      };
    },
  };
}
