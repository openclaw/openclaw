import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import type { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { sqlPublicationAnchor, type PostgresSqlConnection } from "./sql-connection.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerAdmissionTimeoutError,
  type SqliteWorkerExecutionAuthority,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerRequestCustodyDescriptor } from "./sqlite-worker-request-custody.js";

export type SqliteWorkerOperationContext = {
  /** Native source checks finish before the live authority cells are observed. */
  assertPhysicalSourceCurrent?: () => void;
  port: MessagePort;
  databaseAdmissionDeadlineAtMs?: number;
  /** Present for broker-owned work; standalone admission owners keep their own lifetime. */
  requestCustody?: SqliteWorkerRequestCustodyDescriptor;
  executionAuthority?: SqliteWorkerExecutionAuthority;
  databaseIdentity?: SqliteWorkerRequest["databaseIdentity"];
  attachment?: { value: unknown };
  refusal?: SqliteWorkerError | InstanceType<typeof SqliteWorkerAdmissionTimeoutError>;
  committed?: { facts: unknown };
  settled?: true;
  sourceReservations?: true;
  pendingReceipts?: Map<DatabaseSync, number>;
};

export type NativeCommitReceipt = {
  version: 1;
  sequence: number;
  facts: unknown;
};

// The private MessagePort already detached this receipt from its sender.
function isNativeCommitReceipt(value: unknown): value is NativeCommitReceipt {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1 &&
    Object.hasOwn(value, "facts")
  );
}

function isNativeSettlementReceipt(
  value: unknown,
): value is { kind: "completed" | "unknown"; committed?: NativeCommitReceipt } {
  return (
    isRecord(value) &&
    (value.kind === "completed" || value.kind === "unknown") &&
    (value.committed === undefined || isNativeCommitReceipt(value.committed))
  );
}

// Keep the latest committed evidence for settlement if ordinary delivery fails.
const nativeCommitReceipts = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerNativeCommitReceipts"),
  () =>
    new WeakMap<
      SqliteWorkerOperationContext,
      { receipt: NativeCommitReceipt; payloadBytes: number; delivered: boolean }
    >(),
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
  /** Actual native retirement, including failed-close recovery after an unknown outcome. */
  readonly nativeStopped?: Promise<void>;
};

function resolveSqliteWorkerFinishSettlement(
  settlement: SqliteWorkerNativeSettlement | undefined,
  committed: SqliteWorkerNativeSettlementOwner["committed"],
  outcome?: "not-entered",
): SqliteWorkerNativeSettlement | undefined {
  // Only the broker proves dispatch never began. Preserve that no-effect outcome
  // before publication observers mistake missing receipts for an unknown write.
  return (
    settlement ?? (outcome === "not-entered" && !committed ? { kind: "completed" } : undefined)
  );
}

/** Observe each finish after the previously installed handler, including failure. */
export function observeSqliteWorkerAdmissionFinish(
  admission: { finish(outcome?: "not-entered"): void | Promise<void> },
  observer: () => void,
): void {
  const finish = admission.finish.bind(admission);
  admission.finish = (outcome) => {
    let pending: void | Promise<void>;
    try {
      pending = finish(outcome);
    } catch (error) {
      observer();
      throw error;
    }
    if (pending) {
      return pending.finally(observer);
    }
    return observer();
  };
}

export type CapturedSqliteWorkerCommitReceipt =
  | { kind: "inline"; facts: unknown; payloadBytes: number }
  | { kind: "oversized"; serialized: Uint8Array };

export function captureSqliteWorkerCommitReceipt(
  facts: unknown,
): CapturedSqliteWorkerCommitReceipt {
  const serialized = serialize(facts);
  const payloadBytes = serialized.byteLength;
  if (payloadBytes > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
    return { kind: "oversized", serialized };
  }
  // Keep the size and detached facts together so transport selection and native
  // publication use one capture, even if the producer mutates its result later.
  return { kind: "inline", facts: structuredClone(facts), payloadBytes };
}

function deferSqliteWorkerNativeCommitReceipt(
  owner: SqliteWorkerOperationContext,
  database: DatabaseSync | PostgresSqlConnection,
  captured: CapturedSqliteWorkerCommitReceipt,
  delivery: "commit" | "settlement",
): void {
  if (captured.kind === "oversized") {
    throw new SqliteWorkerError(
      "SQLite worker commit receipt exceeds the transport limit",
      "overloaded",
    );
  }
  const { facts, payloadBytes } = captured;
  const anchor = sqlPublicationAnchor(database);
  const counts = (owner.pendingReceipts ??= new Map());
  const pending = (delta: number) => {
    const count = (counts.get(anchor) ?? 0) + delta;
    if (count === 0) {
      counts.delete(anchor);
    } else {
      counts.set(anchor, count);
    }
  };
  if (
    !stageSqliteTransactionState(anchor, {
      stage: () => pending(1),
      rollback: () => pending(-1),
      commit() {
        pending(-1);
        const previous = nativeCommitReceipts.get(owner);
        const receipt: NativeCommitReceipt = {
          version: 1,
          sequence: (previous?.receipt.sequence ?? 0) + 1,
          facts,
        };
        const retained = { receipt, payloadBytes, delivered: false };
        nativeCommitReceipts.set(owner, retained);
        owner.committed = { facts };
        if (delivery === "commit") {
          owner.port.postMessage({ kind: "native-commit", committed: receipt, payloadBytes }, []);
          retained.delivered = true;
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
  const retained = nativeCommitReceipts.get(owner);
  // This private port is FIFO: settlement only carries facts not already posted successfully.
  const pending = retained?.delivered ? undefined : retained;
  owner.port.postMessage(
    {
      kind: "native-settlement",
      settlement: { kind, ...(pending ? { committed: pending.receipt } : {}) },
      payloadBytes: pending?.payloadBytes ?? 0,
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

/** Record facts only after the real transaction commits, before native settlement is announced. */
export function deferSqliteWorkerCommitReceipt(
  database: DatabaseSync | PostgresSqlConnection,
  facts: unknown,
  delivery: "commit" | "settlement" = "commit",
): void {
  const scope = currentSqliteWorkerOperationAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  deferSqliteWorkerNativeCommitReceipt(
    scope.owner,
    database,
    captureSqliteWorkerCommitReceipt(facts),
    delivery,
  );
}

/** Reuse the capture that selected an inline transport; publication still belongs to COMMIT. */
export function deferCapturedSqliteWorkerCommitReceipt(
  database: DatabaseSync | PostgresSqlConnection,
  captured: Extract<CapturedSqliteWorkerCommitReceipt, { kind: "inline" }>,
  delivery: "commit" | "settlement" = "commit",
): void {
  const scope = currentSqliteWorkerOperationAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  deferSqliteWorkerNativeCommitReceipt(scope.owner, database, captured, delivery);
}

/** A typed fenced write cannot commit without its destination owner's settlement evidence. */
export function assertSqliteWorkerCommitReceiptPending(
  database: DatabaseSync | PostgresSqlConnection,
): void {
  const scope = currentSqliteWorkerOperationAdmission.getStore();
  if (!scope?.active || !scope.owner.pendingReceipts?.get(sqlPublicationAnchor(database))) {
    throw new SqliteWorkerError(
      "SQLite source fence requires a destination commit receipt",
      "closed",
    );
  }
}

/** Host publication retains only native receipts after its operation releases authority. */
export function createSqliteWorkerNativeReceiptOwner(
  inOwnerContext: (operation: () => void) => void,
  recordFailure: (error: unknown) => void,
) {
  const commitObservers: ((committed: { facts: unknown }) => void)[] = [];
  let observingCommit = false;
  let committed: SqliteWorkerNativeSettlementOwner["committed"];
  let nativeReceiptSequence = 0;
  let settlement: SqliteWorkerNativeSettlement | undefined;
  const invalidProtocol = (kind: "commit receipt" | "native settlement") =>
    recordFailure(new SqliteWorkerError(`SQLite worker ${kind} is invalid`, "outcome-unknown"));
  const installCommitted = (receipt: NativeCommitReceipt): void => {
    // Each private port delivers receipts in order; repeated receipts remain idempotent.
    if (receipt.sequence <= nativeReceiptSequence) {
      return;
    }
    nativeReceiptSequence = receipt.sequence;
    const publication = { facts: receipt.facts };
    committed = publication;
    observingCommit = true;
    try {
      inOwnerContext(() => {
        for (const observer of commitObservers) {
          observer(publication);
        }
      });
    } catch (error) {
      recordFailure(
        Object.assign(
          new SqliteWorkerError("SQLite committed facts publication failed", "outcome-unknown"),
          { cause: error },
        ),
      );
    } finally {
      observingCommit = false;
    }
  };
  return {
    get committed() {
      return committed;
    },
    get settlement() {
      return settlement;
    },
    get observingCommit() {
      return observingCommit;
    },
    observe(observer: (committed: { facts: unknown }) => void) {
      commitObservers.push(observer);
    },
    receive(message: unknown): boolean {
      if (isRecord(message) && message.kind === "native-commit") {
        const receipt = message.committed;
        if (!isNativeCommitReceipt(receipt)) {
          invalidProtocol("commit receipt");
          return true;
        }
        installCommitted(receipt);
        return true;
      }
      if (isRecord(message) && message.kind === "native-settlement") {
        const value = message.settlement;
        if (!isNativeSettlementReceipt(value)) {
          invalidProtocol("native settlement");
          return true;
        }
        if (value.committed !== undefined) {
          installCommitted(value.committed);
        }
        settlement = {
          kind: value.kind,
          ...(committed ? { committed } : {}),
        };
        return true;
      }
      return false;
    },
    finish(outcome?: "not-entered") {
      settlement = resolveSqliteWorkerFinishSettlement(settlement, committed, outcome);
      // Preserve an active observer iteration when publication itself ends custody.
      if (observingCommit) {
        queueMicrotask(() => {
          commitObservers.length = 0;
        });
      } else {
        commitObservers.length = 0;
      }
    },
  };
}
