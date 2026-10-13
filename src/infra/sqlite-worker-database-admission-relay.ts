import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import {
  readSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissions,
} from "./sqlite-database-admission-record.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

const REQUESTED = 0;
const GRANTED = 1;
export const SQLITE_COLD_ADMISSION_PENDING = 4;

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
  try {
    port.postMessage(
      {
        kind: "sqlite-database-admissions",
        admissions,
        location,
        create,
        port: port2,
        decision: decision.buffer,
      },
      [port2],
    );
    while (Atomics.load(decision, 0) === REQUESTED) {
      Atomics.wait(decision, 0, REQUESTED);
    }
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
    port1.close();
    port2.close();
  }
}
