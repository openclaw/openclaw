import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;
const ADMISSION_TIMEOUT_MS = 5_000;

type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
};

export type SqliteWorkerOperationAdmission = {
  readonly port: MessagePort;
  readonly failure: unknown;
  readonly cleanupFailures: readonly unknown[];
  service(): void;
  finish(): void;
};

export type SqliteWorkerAdmissionFactory = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
};

/** The caller retains real source custody before invoking the synchronous grant. */
export function createSqliteWorkerOperationAdmission(
  admit: (request: SqliteWorkerAdmissionRequest, grant: () => boolean) => void,
): SqliteWorkerOperationAdmission {
  const { port1, port2 } = new MessageChannel();
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const decisions = new Set<Int32Array>();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let failure: unknown;
  const refuse = (decision: Int32Array, error: unknown) => {
    if (Atomics.compareExchange(decision, 0, REQUESTED, REFUSED) === REQUESTED) {
      failure ??= error;
      Atomics.notify(decision, 0);
    } else if (Atomics.load(decision, 0) === GRANTED) {
      cleanupFailures.push(error);
    }
  };
  const receive = (message: unknown) => {
    if (
      !isRecord(message) ||
      !(message.decision instanceof SharedArrayBuffer) ||
      message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
      (message.stage !== "open" &&
        message.stage !== "prepare" &&
        message.stage !== "transaction" &&
        message.stage !== "commit")
    ) {
      failure ??= new SqliteWorkerError(
        "SQLite worker admission request is invalid",
        "unavailable",
      );
      return;
    }
    const decision = new Int32Array(message.decision);
    decisions.add(decision);
    if (closed) {
      refuse(decision, new SqliteWorkerError("SQLite worker admission is closed", "closed"));
      return;
    }
    const request: SqliteWorkerAdmissionRequest = { stage: message.stage, facts: message.facts };
    const grant = () => {
      if (closed) {
        return false;
      }
      const granted = Atomics.compareExchange(decision, 0, REQUESTED, GRANTED) === REQUESTED;
      if (granted) {
        Atomics.notify(decision, 0);
      }
      return granted;
    };
    try {
      inOwnerContext(admit, request, grant);
    } catch (error) {
      refuse(decision, error);
      return;
    }
    if (Atomics.load(decision, 0) === REQUESTED) {
      refuse(decision, new SqliteWorkerError("SQLite worker admission was not granted", "closed"));
    }
  };
  port1.on("message", receive);
  port1.unref();
  return {
    port: port2,
    get failure() {
      return failure;
    },
    get cleanupFailures() {
      return cleanupFailures;
    },
    service() {
      for (let queued = receiveMessageOnPort(port1); queued; queued = receiveMessageOnPort(port1)) {
        receive(queued.message);
      }
    },
    finish() {
      closed = true;
      for (const decision of decisions) {
        if (Atomics.load(decision, 0) === REQUESTED) {
          refuse(decision, new SqliteWorkerError("SQLite worker admission is closed", "closed"));
        }
      }
      port1.close();
      port2.close();
    },
  };
}

type WorkerAdmissionScope = {
  port: MessagePort;
  active: boolean;
};
// Source brokers and built plugin backends can load separate module copies in
// one Worker. Share the carrier, while each operation still owns its private port.
const currentAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOperationAdmission"),
  () => new AsyncLocalStorage<WorkerAdmissionScope>(),
);

/** Install only the private port belonging to the broker's currently executing operation. */
export function withSqliteWorkerOperationAdmission<T>(port: MessagePort, operation: () => T): T {
  const scope = { port, active: true };
  try {
    return currentAdmission.run(scope, operation);
  } finally {
    scope.active = false;
  }
}

/** Called on the SQLite worker, after transaction entry and before its row mutation. */
export function requestSqliteWorkerOperationAdmission(request: SqliteWorkerAdmissionRequest): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  scope.port.postMessage({ ...request, decision: decision.buffer }, []);
  Atomics.wait(decision, 0, REQUESTED, ADMISSION_TIMEOUT_MS);
  if (Atomics.load(decision, 0) !== GRANTED) {
    Atomics.compareExchange(decision, 0, REQUESTED, REFUSED);
    throw new SqliteWorkerError("SQLite transaction admission was refused", "closed");
  }
}
