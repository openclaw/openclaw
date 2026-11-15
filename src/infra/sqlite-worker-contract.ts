import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import type { PostgresPoolEndpoints } from "./postgres-sync/pool-state.js";
import type { SqliteDatabaseAdmissions } from "./sqlite-database-admission.js";
import {
  SQLITE_WORKER_SOURCE_FENCE,
  type SqliteSourceFence,
} from "./sqlite-source-fence-contract.js";
import type { SqliteWalCheckpointSnapshot } from "./sqlite-wal-checkpoint.js";
import type { DatabaseFileIdentity, DatabasePathIdentity } from "./sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import type { SqliteWorkerTransferHandle } from "./sqlite-worker-transfer.js";

export {
  SqliteWorkerError,
  wrapSqliteWorkerError,
  retainSqliteWorkerErrorCode,
  isSqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "./sqlite-worker-error.js";

export type SqliteWorkerRequestCustodyDescriptor = {
  slot: Int32Array<SharedArrayBuffer>;
  request: Int32Array<SharedArrayBuffer>;
};

export type SqliteWorkerExecutionAuthority = {
  logical: Int32Array<SharedArrayBuffer>;
  native: Int32Array<SharedArrayBuffer>;
  physicalIdentity: string;
  incarnation: string;
  birthtime?: string;
};

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
  /** Opt-in wait budget in milliseconds; omission retains the live-owner wait. */
  deadlineMs?: number;
};

export type SqliteWorkerAdmissionHandler = (
  request: SqliteWorkerAdmissionRequest,
  grant: (beforeRelease?: () => void) => boolean,
) => void;

export type SqliteWorkerDatabaseAuthority = {
  /** Canonical identity captured when the database owner was admitted. */
  databasePath: string;
  databaseIdentity?: SqliteWorkerRequest["databaseIdentity"];
  /** Only the broker can identify an initial open of its captured primary database. */
  coldOpenPath?: string;
  assertRequest?(): void;
  assertAccess(): void;
  assertCreate?(databasePath: string): void;
  prepareCreate?(databasePath: string): Promise<void>;
  acquireSchema(): { assertCurrent(): void; release(): void };
};

// Each side measures admission deadlines on its own thread's monotonic clock
// captured at import: fake timers replace `process.hrtime` with a clock that
// starts at zero, and Bun's real `process.hrtime` origin differs per thread.
const processMonotonicClock = process.hrtime;

/** Monotonic nanoseconds for deadlines measured within the calling thread. */
export function readSqliteWorkerMonotonicNs(): bigint {
  return processMonotonicClock.bigint();
}

export type SqliteWorkerOperations = Record<string, { input: unknown; output: unknown }>;
export type SqliteWorkerCommand<Operations extends SqliteWorkerOperations> = {
  [Key in keyof Operations]: { type: Key; input: Operations[Key]["input"] };
}[keyof Operations];

export type SqliteWorkerBackend<Operations extends SqliteWorkerOperations> = {
  /** Load command prerequisites before synchronous execution enters native work. */
  prepare?(command: SqliteWorkerCommand<Operations>): void | Promise<void>;
  execute(command: SqliteWorkerCommand<Operations>): Operations[keyof Operations]["output"];
  /** Synchronously reject native state that requires retirement before releasing the operation. */
  assertSettled?(): void;
  close(): void | Promise<void>;
};

/** Recorded during successful native close; this fact never grants database access. */
export type SqliteWorkerCloseReceipt = {
  identity: DatabasePathIdentity;
  incarnation: string;
  checkpoint?: SqliteWalCheckpointSnapshot;
};

// Source fixtures and compiled backends can load separate copies in the same Worker.
export const SQLITE_WORKER_PREPARE_COMMAND = Symbol.for("openclaw.sqliteWorkerPrepareCommand");
export const SQLITE_WORKER_PREPARE_ADMITTED = Symbol.for("openclaw.sqliteWorkerPrepareAdmitted");
export const SQLITE_WORKER_OPERATION_CLEANUP = Symbol.for("openclaw.sqliteWorkerOperationCleanup");
export const SQLITE_WORKER_CLOSE_RECEIPT = Symbol.for("openclaw.sqliteWorkerCloseReceipt");

/** Internal preparation and cleanup facts; public SDK operation and close contracts stay unchanged. */
export type SqliteWorkerPreparedBackend<Operations extends SqliteWorkerOperations> =
  SqliteWorkerBackend<Operations> & {
    [SQLITE_WORKER_PREPARE_COMMAND]?(commandType: keyof Operations): void | Promise<void>;
    [SQLITE_WORKER_PREPARE_ADMITTED]?(
      command: SqliteWorkerCommand<Operations>,
    ): void | Promise<void>;
    [SQLITE_WORKER_OPERATION_CLEANUP]?(command: SqliteWorkerCommand<Operations>): void;
    /** Internal typed durable operations only; legacy callbacks keep their native adapter. */
    [SQLITE_WORKER_SOURCE_FENCE]?(
      command: SqliteWorkerCommand<Operations>,
    ): SqliteSourceFence | undefined;
    [SQLITE_WORKER_CLOSE_RECEIPT]?(): SqliteWorkerCloseReceipt | undefined;
  };

export type SqliteWorkerStore<Operations extends SqliteWorkerOperations> = {
  execute<Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    options?: { signal?: AbortSignal },
  ): Promise<Operations[Key]["output"]>;
  close(): Promise<void>;
};

export type SqliteWorkerRequest = {
  id: number;
  actor: number;
  postgresPool?: PostgresPoolEndpoints;
  stateContext?: SqliteWorkerStateContext;
  operationAdmission?: MessagePort;
  databaseAdmissionDeadlineAtMs?: number;
  operationAttachment?: { value: unknown };
  requestCustody?: SqliteWorkerRequestCustodyDescriptor;
  executionAuthority?: SqliteWorkerExecutionAuthority;
  /** A borrowed client retains its original locator and physical identity across actor reuse. */
  databaseIdentity?: DatabaseFileIdentity & { databasePath: string };
  stateDatabasePath?: string;
  databaseAdmissions?: SqliteDatabaseAdmissions;
  timing?: DiagnosticWorkerRequestFields["timing"];
} & (
  | {
      type: "open";
      moduleUrl: string;
      sourceLoaderUrl?: string;
      databasePath: string;
      existingIdentity?: string;
      openAdmission?: "input" | "identity";
      input: Uint8Array<ArrayBuffer>;
      preparation?: Uint8Array<ArrayBuffer>;
    }
  | { type: "execute"; input: Uint8Array<ArrayBuffer> }
  | { type: "execute-start"; transfer: SqliteWorkerTransferHandle }
  | { type: "execute-frame"; input: Uint8Array<ArrayBuffer> }
  | { type: "result-next"; transferId: number }
  | { type: "close" }
);

export type SqliteWorkerReply = {
  id: number;
  /** Explicit outer BEGINs in this frame, including rollback; excludes savepoints/autocommit. */
  transactionCount?: number;
  timing?: DiagnosticWorkerRequestFields["timing"];
  cleanupFailure?: OpenClawStateWorkerErrorPayload;
} & (
  | {
      ok: true;
      value: Uint8Array;
      transfer?: "start" | "frame";
      input?: "next";
      closeReceipt?: SqliteWorkerCloseReceipt;
      /** Optional wire fact; the native-runtime owner validates it before sibling inheritance. */
      nativeRuntimeAdmission?: unknown;
    }
  | {
      ok: false;
      retire?: true;
      openOutcome?: "refused-before-agent-open";
      openNotEntered?: true;
      /** Direct refusal provenance does not certify that opening had no effects. */
      admissionRefused?: true;
      error: {
        name: string;
        message: string;
        code?: string | number;
        sharedState?: OpenClawStateWorkerErrorPayload;
      };
    }
);

export const SQLITE_WORKER_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
// Larger complete results use bounded frames; this remains the inline reply budget.
export const SQLITE_WORKER_MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** Only the factory's admission before agent open may certify this refusal. */
export const SqliteWorkerOpenRefusedError = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOpenRefusedError"),
  () =>
    class OpenRefusedError extends Error {
      constructor(readonly originalError: unknown) {
        super("SQLite worker admission was refused before agent open", { cause: originalError });
        this.name = "SqliteWorkerOpenRefusedError";
      }
    },
);

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

/** Decode private admission framing and retain the receiving thread's wait budget. */
export function readSqliteWorkerAdmissionDecision(message: unknown):
  | {
      decision: Int32Array<SharedArrayBuffer>;
      expired: () => boolean;
      request: SqliteWorkerAdmissionRequest;
    }
  | undefined {
  const REQUESTED = 0;
  const TIMED_OUT = 3;
  if (
    !isRecord(message) ||
    !(message.decision instanceof SharedArrayBuffer) ||
    message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
    (message.stage !== "open" &&
      message.stage !== "prepare" &&
      message.stage !== "transaction" &&
      message.stage !== "commit")
  ) {
    return undefined;
  }
  const decision = new Int32Array(message.decision);
  // Bun starts process.hrtime at zero in each thread, so the worker's deadline
  // instant cannot cross threads. The host bounds its own late work from receipt;
  // the worker still enforces its budget through the shared decision word.
  const deadlineNs =
    typeof message.deadlineMs === "number" && Number.isFinite(message.deadlineMs)
      ? readSqliteWorkerMonotonicNs() +
        BigInt(Math.max(0, Math.ceil(message.deadlineMs))) * 1_000_000n
      : undefined;
  const expired = () => {
    if (deadlineNs !== undefined && readSqliteWorkerMonotonicNs() >= deadlineNs) {
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
  };
  return { decision, expired, request: { stage: message.stage, facts: message.facts } };
}
