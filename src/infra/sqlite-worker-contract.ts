import type { MessagePort } from "node:worker_threads";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

export type SqliteWorkerTransferHandle = { id: number; kinds: string[] };

export type SqliteWorkerOperations = Record<string, { input: unknown; output: unknown }>;
export type SqliteWorkerCommand<Operations extends SqliteWorkerOperations> = {
  [Key in keyof Operations]: { type: Key; input: Operations[Key]["input"] };
}[keyof Operations];

export type SqliteWorkerBackend<Operations extends SqliteWorkerOperations> = {
  execute(command: SqliteWorkerCommand<Operations>): Operations[keyof Operations]["output"];
  /** Synchronously reject native state that requires retirement before releasing the operation. */
  assertSettled?(): void;
  close(): void | Promise<void>;
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
  stateContext?: SqliteWorkerStateContext;
  gatewaySchemaFence?: MessagePort;
  maintenanceSchemaFence?: MessagePort;
  stateLifecycle?: MessagePort;
  operationAdmission?: MessagePort;
} & (
  | {
      type: "open";
      moduleUrl: string;
      sourceLoaderUrl?: string;
      databasePath: string;
      existingIdentity?: string;
      input: Uint8Array;
    }
  | { type: "execute"; input: Uint8Array }
  | { type: "execute-start"; transfer: SqliteWorkerTransferHandle }
  | { type: "execute-frame"; input: Uint8Array }
  | { type: "result-next"; transferId: number }
  | { type: "close" }
);

export type SqliteWorkerReply = {
  id: number;
} & (
  | { ok: true; value: Uint8Array; transfer?: "start" | "frame"; input?: "next" }
  | {
      ok: false;
      retire?: true;
      openNotEntered?: true;
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
export const SQLITE_WORKER_TRANSFER_FRAME_BYTES = 8 * 1024 * 1024;

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
