import { isNativeError, isProxy } from "node:util/types";
import type { MessagePort } from "node:worker_threads";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { SqliteWalCheckpointSnapshot } from "./sqlite-wal-checkpoint.js";
import type { DatabasePathIdentity } from "./sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import type { SqliteWorkerTransferHandle } from "./sqlite-worker-transfer.js";

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
  checkpoint: SqliteWalCheckpointSnapshot;
};

// Source fixtures and compiled backends can load separate copies in the same Worker.
export const SQLITE_WORKER_PREPARE_COMMAND = Symbol.for("openclaw.sqliteWorkerPrepareCommand");
export const SQLITE_WORKER_CLOSE_RECEIPT = Symbol.for("openclaw.sqliteWorkerCloseReceipt");

/** Internal preparation and cleanup facts; public SDK operation and close contracts stay unchanged. */
export type SqliteWorkerPreparedBackend<Operations extends SqliteWorkerOperations> =
  SqliteWorkerBackend<Operations> & {
    [SQLITE_WORKER_PREPARE_COMMAND]?(commandType: keyof Operations): void | Promise<void>;
    [SQLITE_WORKER_CLOSE_RECEIPT]?(): SqliteWorkerCloseReceipt | undefined;
  };

export type SqliteWorkerStore<Operations extends SqliteWorkerOperations> = {
  execute<Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    options?: { signal?: AbortSignal },
  ): Promise<Operations[Key]["output"]>;
  close(): Promise<void>;
};

/** Optional maintenance budget; ordinary operations keep the database's default lock wait. */
export type SqliteWorkerStateLifecycle = boolean | { waitMs: number; maxPollIntervalMs?: number };

export type SqliteWorkerRequest = {
  id: number;
  actor: number;
  stateContext?: SqliteWorkerStateContext;
  gatewaySchemaFence?: MessagePort;
  maintenanceSchemaFence?: MessagePort;
  stateLifecycle?: MessagePort;
  workerStateLifecycle?: { deadlineNs: bigint; maxPollIntervalMs?: number };
  lifecyclePreparation?: MessagePort;
  operationAdmission?: MessagePort;
  stateDatabasePath?: string;
} & (
  | {
      type: "open";
      moduleUrl: string;
      sourceLoaderUrl?: string;
      databasePath: string;
      existingIdentity?: string;
      openAdmission?: "input" | "identity";
      input: Uint8Array;
      preparation?: Uint8Array;
    }
  | { type: "execute"; input: Uint8Array }
  | { type: "execute-start"; transfer: SqliteWorkerTransferHandle }
  | { type: "execute-frame"; input: Uint8Array }
  | { type: "result-next"; transferId: number }
  | { type: "close" }
);

export type SqliteWorkerReply = {
  id: number;
  cleanupFailure?: OpenClawStateWorkerErrorPayload;
} & (
  | {
      ok: true;
      value: Uint8Array;
      transfer?: "start" | "frame";
      input?: "next";
      closeReceipt?: SqliteWorkerCloseReceipt;
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

// The process-global broker can return errors to a different source/built module copy.
const retainedWorkerErrorCode = Symbol.for("openclaw.sqliteWorkerErrorCode");

export class SqliteWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "closed" | "overloaded" | "unavailable" | "outcome-unknown",
  ) {
    super(message);
    this.name = "SqliteWorkerError";
    Object.defineProperty(this, retainedWorkerErrorCode, { value: code });
  }
}

/** Carry only canonical worker classification through a local cleanup aggregate. */
export function retainSqliteWorkerErrorCode(error: Error, source: unknown): Error {
  let code: unknown;
  try {
    code = Object.getOwnPropertyDescriptor(source, retainedWorkerErrorCode)?.value;
  } catch {
    // Optional classification must not replace an error that refuses inspection.
    return error;
  }
  if (
    code === "closed" ||
    code === "overloaded" ||
    code === "unavailable" ||
    code === "outcome-unknown"
  ) {
    Object.defineProperty(error, retainedWorkerErrorCode, { value: code });
    Object.assign(error, { code });
  }
  return error;
}

/** Recognize canonical broker errors without admitting cleanup aggregates for retry. */
export function isSqliteWorkerError(
  error: unknown,
  code: SqliteWorkerError["code"],
): error is SqliteWorkerError {
  if (!(error instanceof Error) || error instanceof AggregateError) {
    return false;
  }
  try {
    return Object.getOwnPropertyDescriptor(error, retainedWorkerErrorCode)?.value === code;
  } catch {
    return false;
  }
}

/** Unknown native outcomes remain terminal through canonical cause and cleanup envelopes. */
export function hasSqliteWorkerOutcomeUnknown(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current) || isProxy(current) || !isNativeError(current)) {
      continue;
    }
    seen.add(current);
    if (
      Object.getOwnPropertyDescriptor(current, retainedWorkerErrorCode)?.value === "outcome-unknown"
    ) {
      return true;
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    if (cause && "value" in cause) {
      pending.push(cause.value);
    }
    let prototype = Object.getPrototypeOf(current);
    let aggregate = false;
    while (prototype && !isProxy(prototype)) {
      const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      if (
        prototype === AggregateError.prototype ||
        (typeof constructor === "function" &&
          !isProxy(constructor) &&
          Object.getOwnPropertyDescriptor(constructor, "name")?.value === "AggregateError" &&
          Object.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype &&
          Object.getOwnPropertyDescriptor(prototype, "name")?.value === "AggregateError")
      ) {
        aggregate = true;
        break;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!aggregate) {
      continue;
    }
    const errors: unknown = Object.getOwnPropertyDescriptor(current, "errors")?.value;
    if (isProxy(errors) || !Array.isArray(errors)) {
      continue;
    }
    // Read data slots, never an error object's getters or a supplied array iterator.
    for (const key of Object.keys(errors)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) {
        continue;
      }
      const item = Object.getOwnPropertyDescriptor(errors, key);
      if (item && "value" in item) {
        pending.push(item.value);
      }
    }
  }
  return false;
}
