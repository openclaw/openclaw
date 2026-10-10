import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import type { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerAdmissionTimeoutError,
} from "./sqlite-worker-contract.js";

export type SqliteWorkerOperationContext = {
  port: MessagePort;
  attachment?: { value: unknown };
  refusal?: SqliteWorkerError | InstanceType<typeof SqliteWorkerAdmissionTimeoutError>;
  committed?: { facts: unknown };
  settled?: true;
  sourceReservations?: true;
  pendingReceipts?: Map<DatabaseSync, number>;
};

export type NativeCommitReceipt = {
  version: 1;
  operationId: string;
  sequence: number;
  facts: unknown;
};

export function readNativeCommitReceipt(value: unknown): NativeCommitReceipt | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Object.hasOwn(value, "facts")
  ) {
    return undefined;
  }
  return {
    version: 1,
    operationId: value.operationId,
    sequence: value.sequence,
    facts: value.facts,
  };
}

// Private wire identity follows the native operation across transformed module copies.
const nativeCommitReceipts = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerNativeCommitReceipts"),
  () => new WeakMap<SqliteWorkerOperationContext, NativeCommitReceipt>(),
);

/** Native settlement is independent of whether delivery of the result succeeded. */
export type SqliteWorkerOperationSettlement =
  | { kind: "completed" }
  | { kind: "not-entered"; error: unknown }
  | { kind: "unknown"; error: unknown; nativeStopped?: true };

/** Private operation receipts describe completed work; they never grant write authority. */
export type SqliteWorkerNativeSettlement =
  | { kind: "completed"; committed?: { facts: unknown } }
  | { kind: "unknown"; committed?: { facts: unknown } };

export type SqliteWorkerNativeSettlementOwner = {
  readonly committed: { facts: unknown } | undefined;
  readonly settlement: SqliteWorkerNativeSettlement | undefined;
  waitForSettlement(
    deadlineMs: number,
  ): Extract<SqliteWorkerNativeSettlement, { kind: "completed" }>;
};

/** The broker resolves this only from the executing owner's settlement evidence. */
export type RetainedWorkerTransactionAdmission = {
  readonly settled: Promise<SqliteWorkerOperationSettlement>;
};

export function deferSqliteWorkerNativeCommitReceipt(
  owner: SqliteWorkerOperationContext,
  database: DatabaseSync,
  facts: unknown,
  delivery: "commit" | "settlement",
): void {
  if (serialize(facts).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
    throw new SqliteWorkerError(
      "SQLite worker commit receipt exceeds the transport limit",
      "overloaded",
    );
  }
  const captured = structuredClone(facts);
  const operationId = nativeCommitReceipts.get(owner)?.operationId ?? randomUUID();
  const counts = owner.sourceReservations ? (owner.pendingReceipts ??= new Map()) : undefined;
  const pending = (delta: number) => {
    if (!counts) {
      return;
    }
    const count = (counts.get(database) ?? 0) + delta;
    if (count === 0) {
      counts.delete(database);
    } else {
      counts.set(database, count);
    }
  };
  if (
    !stageSqliteTransactionState(database, {
      stage: () => pending(1),
      rollback: () => pending(-1),
      commit() {
        pending(-1);
        const previous = nativeCommitReceipts.get(owner);
        const receipt: NativeCommitReceipt = {
          version: 1,
          operationId: previous?.operationId ?? operationId,
          sequence: (previous?.sequence ?? 0) + 1,
          facts: captured,
        };
        nativeCommitReceipts.set(owner, receipt);
        owner.committed = { facts: captured };
        if (delivery === "commit") {
          owner.port.postMessage({ kind: "native-commit", committed: receipt }, []);
        }
      },
    })
  ) {
    throw new Error("SQLite worker receipt requires a transaction publication owner");
  }
}

/** The executing worker calls this only after its backend's native settlement check. */
export function settleSqliteWorkerOperationContext(
  owner: SqliteWorkerOperationContext,
  kind: "completed" | "unknown",
): void {
  if (owner.settled) {
    return;
  }
  owner.settled = true;
  const committed = nativeCommitReceipts.get(owner);
  owner.port.postMessage(
    {
      kind: "native-settlement",
      settlement: { kind, ...(committed ? { committed } : {}) },
    },
    [],
  );
}

export type WorkerAdmissionScope = {
  // Published SDK request helpers share these port/active carrier fields.
  port: MessagePort;
  owner: SqliteWorkerOperationContext;
  active: boolean;
};
// Source brokers and built plugin backends can load separate module copies in
// one Worker. Share the carrier, while each operation still owns its private port.
export const currentSqliteWorkerOperationAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOperationAdmission"),
  () => new AsyncLocalStorage<WorkerAdmissionScope>(),
);
