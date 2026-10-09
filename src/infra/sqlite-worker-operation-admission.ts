import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import {
  MessageChannel,
  receiveMessageOnPort,
  type MessagePort,
  type Transferable,
} from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import { currentSqliteOperationTiming } from "./sqlite-reader-lifecycle.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES, SqliteWorkerError } from "./sqlite-worker-contract.js";
import type {
  RetainedWorkerTransactionAdmission,
  SqliteWorkerNativeSettlement,
  SqliteWorkerNativeSettlementOwner,
} from "./sqlite-worker-operation-settlement.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;

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

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
};

type AdmissionFailureSource = "authority" | "domain" | "protocol";

export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly port: MessagePort;
  readonly failure: unknown;
  readonly failureSource: AdmissionFailureSource | undefined;
  readonly cleanupFailures: readonly unknown[];
  observeRequests(observer: (request: SqliteWorkerAdmissionRequest) => void): void;
  service(): void;
  finish(): void;
  bindDatabaseAuthority(authority: {
    databasePath: string;
    assertRequest?(): void;
    assertAccess(): void;
    acquireSchema(): { assertCurrent(): void; release(): void };
  }): void;
};

export type SqliteWorkerAdmissionFactory = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
};

type CommitObserver = (committed: { facts: unknown }) => void;
type NativeCommitReceipt = {
  version: 1;
  operationId: string;
  sequence: number;
  facts: unknown;
};

function readNativeCommitReceipt(value: unknown): NativeCommitReceipt | undefined {
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

const commitObserverBindings = new WeakMap<
  SqliteWorkerOperationAdmission,
  (observer: CommitObserver) => void
>();

/** Private publication binding leaves released SDK admission factories structurally unchanged. */
export function observeSqliteWorkerCommittedFacts(
  admission: SqliteWorkerOperationAdmission,
  observer: CommitObserver,
): void {
  const bind = commitObserverBindings.get(admission);
  if (!bind) {
    throw new SqliteWorkerError("SQLite admission has no native receipt owner", "unavailable");
  }
  bind(observer);
}

/** The optional continuation runs under live host authority before releasing the native writer. */
export function createSqliteWorkerOperationAdmission(
  admit: (
    request: SqliteWorkerAdmissionRequest,
    grant: (beforeRelease?: () => void) => boolean,
  ) => void,
  attachment?: unknown,
): SqliteWorkerOperationAdmission {
  const { port1, port2 } = new MessageChannel();
  if (attachment !== undefined) {
    try {
      // This message moves with port2; command payloads retain their v8 encoding.
      port1.postMessage({ kind: "sqlite-operation-attachment", value: attachment }, []);
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  }
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const decisions = new Set<Int32Array>();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let started = false;
  let observeRequest: ((request: SqliteWorkerAdmissionRequest) => void) | undefined;
  let observeCommit: ((committed: { facts: unknown }) => void) | undefined;
  let observingCommit = false;
  let failure: { error: unknown; source: AdmissionFailureSource } | undefined;
  let committed: SqliteWorkerNativeSettlementOwner["committed"];
  let nativeReceipt: NativeCommitReceipt | undefined;
  let settlement: SqliteWorkerNativeSettlement | undefined;
  let databaseAuthority:
    | {
        databasePath: string;
        assertRequest?(): void;
        assertAccess(): void;
        acquireSchema(): { assertCurrent(): void; release(): void };
        lease?: { assertCurrent(): void; release(): void };
      }
    | undefined;
  const waiting = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const recordFailure = (error: unknown, source: AdmissionFailureSource) => {
    // A handled domain refusal cannot hide a later loss of physical custody or protocol failure.
    if (!failure || (failure.source === "domain" && source !== "domain")) {
      failure = { error, source };
    }
  };
  const refuse = (decision: Int32Array, error: unknown, source: AdmissionFailureSource) => {
    if (Atomics.compareExchange(decision, 0, REQUESTED, REFUSED) === REQUESTED) {
      recordFailure(error, source);
      Atomics.notify(decision, 0);
    } else if (Atomics.load(decision, 0) === GRANTED) {
      cleanupFailures.push(error);
    }
  };
  const invalidReceipt = () => {
    recordFailure(
      new SqliteWorkerError("SQLite worker commit receipt is invalid", "outcome-unknown"),
      "protocol",
    );
  };
  const installCommitted = (receipt: NativeCommitReceipt): boolean => {
    if (nativeReceipt) {
      if (receipt.operationId !== nativeReceipt.operationId) {
        invalidReceipt();
        return false;
      }
      if (receipt.sequence < nativeReceipt.sequence) {
        return true;
      }
      if (receipt.sequence === nativeReceipt.sequence) {
        if (!isDeepStrictEqual(nativeReceipt, receipt)) {
          invalidReceipt();
          return false;
        }
        return true;
      }
    }
    if (settlement) {
      invalidReceipt();
      return false;
    }
    nativeReceipt = receipt;
    const publication = { facts: receipt.facts };
    committed = publication;
    observingCommit = true;
    try {
      inOwnerContext(() => observeCommit?.(publication));
    } catch (error) {
      recordFailure(
        Object.assign(
          new SqliteWorkerError("SQLite committed facts publication failed", "outcome-unknown"),
          { cause: error },
        ),
        "protocol",
      );
    } finally {
      observingCommit = false;
    }
    return true;
  };
  const receive = (message: unknown) => {
    started = true;
    if (isRecord(message) && message.kind === "native-commit") {
      const receipt = readNativeCommitReceipt(message.committed);
      if (!receipt) {
        invalidReceipt();
        return;
      }
      installCommitted(receipt);
      return;
    }
    if (isRecord(message) && message.kind === "native-settlement") {
      const value = message.settlement;
      const receipt = isRecord(value) ? readNativeCommitReceipt(value.committed) : undefined;
      if (
        !isRecord(value) ||
        (value.kind !== "completed" && value.kind !== "unknown") ||
        (value.committed !== undefined && !receipt) ||
        (nativeReceipt &&
          (!receipt ||
            receipt.operationId !== nativeReceipt.operationId ||
            receipt.sequence < nativeReceipt.sequence)) ||
        (settlement &&
          (settlement.kind !== value.kind || !isDeepStrictEqual(nativeReceipt, receipt)))
      ) {
        recordFailure(
          new SqliteWorkerError("SQLite worker native settlement is invalid", "outcome-unknown"),
          "protocol",
        );
        return;
      }
      if (receipt && !installCommitted(receipt)) {
        return;
      }
      settlement = {
        kind: value.kind,
        ...(committed ? { committed } : {}),
      };
      return;
    }
    if (
      !isRecord(message) ||
      !(message.decision instanceof SharedArrayBuffer) ||
      message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
      (message.stage !== "open" &&
        message.stage !== "prepare" &&
        message.stage !== "transaction" &&
        message.stage !== "commit")
    ) {
      recordFailure(
        new SqliteWorkerError("SQLite worker admission request is invalid", "unavailable"),
        "protocol",
      );
      return;
    }
    const decision = new Int32Array(message.decision);
    decisions.add(decision);
    const request: SqliteWorkerAdmissionRequest = { stage: message.stage, facts: message.facts };
    try {
      // A queued fact may describe an earlier COMMIT; observing it never grants more work.
      inOwnerContext(() => observeRequest?.(request));
    } catch (error) {
      refuse(decision, error, "domain");
      return;
    }
    if (closed) {
      refuse(
        decision,
        new SqliteWorkerError("SQLite worker admission is closed", "closed"),
        "authority",
      );
      return;
    }
    const grant = (beforeRelease?: () => void) => {
      if (closed || Atomics.load(decision, 0) !== REQUESTED) {
        return false;
      }
      // Domain admission can reenter owner lifecycle before handing the native writer its grant.
      try {
        inOwnerContext(() => databaseAuthority?.assertAccess());
      } catch (error) {
        refuse(decision, error, "authority");
        return false;
      }
      if (closed || Atomics.load(decision, 0) !== REQUESTED) {
        return false;
      }
      beforeRelease?.();
      const granted = Atomics.compareExchange(decision, 0, REQUESTED, GRANTED) === REQUESTED;
      if (granted) {
        Atomics.notify(decision, 0);
      }
      return granted;
    };
    let source: AdmissionFailureSource = "authority";
    try {
      inOwnerContext(() => {
        databaseAuthority?.assertRequest?.();
        databaseAuthority?.assertAccess();
      });
      if (
        request.stage === "prepare" &&
        isRecord(request.facts) &&
        request.facts.kind === "schema-maintenance"
      ) {
        const authority = databaseAuthority;
        if (
          !authority ||
          typeof request.facts.databasePath !== "string" ||
          resolveIdentityPathViaExistingAncestorSync(request.facts.databasePath) !==
            authority.databasePath
        ) {
          throw new SqliteWorkerError(
            "SQLite schema maintenance target differs from its admitted database",
            "closed",
          );
        }
        inOwnerContext(() => {
          authority.lease ??= authority.acquireSchema();
          authority.lease.assertCurrent();
          grant();
        });
      } else {
        source = "domain";
        inOwnerContext(admit, request, grant);
      }
    } catch (error) {
      refuse(decision, error, source);
      return;
    } finally {
      // Repeated preparation requests must not retain every settled decision.
      decisions.delete(decision);
    }
    if (Atomics.load(decision, 0) === REQUESTED) {
      refuse(
        decision,
        new SqliteWorkerError("SQLite worker admission was not granted", "closed"),
        "domain",
      );
    }
  };
  port1.on("message", receive);
  port1.unref();
  const service = () => {
    // Observers may inspect retained facts without recursively publishing the next receipt.
    if (observingCommit) {
      return;
    }
    for (let queued = receiveMessageOnPort(port1); queued; queued = receiveMessageOnPort(port1)) {
      receive(queued.message);
    }
  };
  const admission: SqliteWorkerOperationAdmission = {
    port: port2,
    observeRequests(observer) {
      if (closed || observeRequest) {
        throw new SqliteWorkerError(
          "SQLite request observation is already bound or closed",
          "closed",
        );
      }
      observeRequest = observer;
    },
    bindDatabaseAuthority(authority) {
      if (closed || databaseAuthority) {
        throw new SqliteWorkerError(
          "SQLite database authority is already bound or closed",
          "closed",
        );
      }
      databaseAuthority = {
        ...authority,
        databasePath: resolveIdentityPathViaExistingAncestorSync(authority.databasePath),
      };
    },
    get failure() {
      return failure?.error;
    },
    get failureSource() {
      return failure?.source;
    },
    get cleanupFailures() {
      return cleanupFailures;
    },
    get committed() {
      // Event callbacks can precede delivery of already queued commit facts.
      service();
      return committed;
    },
    get settlement() {
      return settlement;
    },
    waitForSettlement(deadlineMs) {
      while (true) {
        service();
        if (failure !== undefined) {
          throw toErrorObject(failure.error, "SQLite worker admission failed");
        }
        if (settlement?.kind === "completed") {
          return settlement;
        }
        const remaining = deadlineMs - performance.now();
        if (settlement?.kind === "unknown" || closed || remaining <= 0) {
          throw new SqliteWorkerError(
            "SQLite worker native settlement is unknown",
            "outcome-unknown",
          );
        }
        Atomics.wait(waiting, 0, 0, Math.min(5, remaining));
      }
    },
    service,
    finish() {
      closed = true;
      // Receipts remain observable; late requests can no longer obtain authority.
      service();
      for (const decision of decisions) {
        if (Atomics.load(decision, 0) === REQUESTED) {
          refuse(
            decision,
            new SqliteWorkerError("SQLite worker admission is closed", "closed"),
            "authority",
          );
        }
      }
      port1.close();
      port2.close();
      if (databaseAuthority?.lease) {
        try {
          databaseAuthority.lease.release();
          databaseAuthority.lease = undefined;
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    },
  };
  commitObserverBindings.set(admission, (observer) => {
    if (closed || observeCommit || started) {
      throw new SqliteWorkerError(
        "SQLite commit observation is already bound or started",
        "closed",
      );
    }
    observeCommit = observer;
  });
  return admission;
}

export type SqliteWorkerOperationContext = {
  port: MessagePort;
  attachment?: { value: unknown };
  refusal?: SqliteWorkerError;
  committed?: { facts: unknown };
  settled?: true;
};

// Private wire identity follows the native operation across transformed module copies.
const nativeCommitReceipts = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerNativeCommitReceipts"),
  () => new WeakMap<SqliteWorkerOperationContext, NativeCommitReceipt>(),
);

type WorkerAdmissionScope = {
  // Published SDK request helpers share these port/active carrier fields.
  port: MessagePort;
  owner: SqliteWorkerOperationContext;
  active: boolean;
};
// Source brokers and built plugin backends can load separate module copies in
// one Worker. Share the carrier, while each operation still owns its private port.
const currentAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerOperationAdmission"),
  () => new AsyncLocalStorage<WorkerAdmissionScope>(),
);

/** Install only the private port belonging to the broker's currently executing operation. */
export function withSqliteWorkerOperationAdmission<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T,
): T {
  const scope = { owner, port: owner.port, active: true };
  try {
    return currentAdmission.run(scope, operation);
  } finally {
    scope.active = false;
  }
}

/** Record facts only after the real transaction commits, before native settlement is announced. */
export function deferSqliteWorkerCommitReceipt(database: DatabaseSync, facts: unknown): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  if (serialize(facts).byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
    throw new SqliteWorkerError(
      "SQLite worker commit receipt exceeds the transport limit",
      "overloaded",
    );
  }
  const captured = structuredClone(facts);
  const operationId = nativeCommitReceipts.get(scope.owner)?.operationId ?? randomUUID();
  if (
    !stageSqliteTransactionState(database, {
      stage() {},
      rollback() {},
      commit() {
        const previous = nativeCommitReceipts.get(scope.owner);
        const receipt: NativeCommitReceipt = {
          version: 1,
          operationId: previous?.operationId ?? operationId,
          sequence: (previous?.sequence ?? 0) + 1,
          facts: captured,
        };
        nativeCommitReceipts.set(scope.owner, receipt);
        scope.owner.committed = { facts: captured };
        scope.owner.port.postMessage({ kind: "native-commit", committed: receipt }, []);
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

/** Called on the SQLite worker, after transaction entry and before its row mutation. */
export function requestSqliteWorkerOperationAdmission(
  request: SqliteWorkerAdmissionRequest,
  transferList: Transferable[] = [],
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const startedAt = Date.now();
  scope.port.postMessage({ ...request, decision: decision.buffer }, transferList);
  // Host scheduling delay does not revoke the retained owner's authority. The
  // broker keeps this port through settlement and joins worker exit on failure;
  // only the live host owner can grant or refuse the pending request.
  while (Atomics.load(decision, 0) === REQUESTED) {
    Atomics.wait(decision, 0, REQUESTED);
  }
  const timing = currentSqliteOperationTiming();
  if (timing) {
    timing.hostAdmissionWaitMs += Date.now() - startedAt;
  }
  if (Atomics.load(decision, 0) !== GRANTED) {
    const refusal = new SqliteWorkerError("SQLite transaction admission was refused", "closed");
    scope.owner.refusal = refusal;
    throw refusal;
  }
}

/** Schema work borrows live host authority through the same retained job port. */
export function requestSqliteWorkerSchemaMaintenance(databasePath: string): boolean {
  if (!currentAdmission.getStore()) {
    return false;
  }
  requestSqliteWorkerOperationAdmission({
    stage: "prepare",
    facts: { kind: "schema-maintenance", databasePath },
  });
  return true;
}

/** Read optional owner-prepared data once, shared by kernels in the same operation. */
export function readSqliteWorkerOperationAdmissionAttachment(): unknown {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    return undefined;
  }
  if (scope.owner.attachment) {
    return scope.owner.attachment.value;
  }
  const message: unknown = receiveMessageOnPort(scope.port)?.message;
  if (
    message !== undefined &&
    (!isRecord(message) || message.kind !== "sqlite-operation-attachment")
  ) {
    throw new SqliteWorkerError("SQLite operation attachment is unavailable", "unavailable");
  }
  const value = isRecord(message) ? message.value : undefined;
  scope.owner.attachment = { value };
  return value;
}

/** Require owner-prepared data from this executing operation's private port. */
export function takeSqliteWorkerOperationAdmissionAttachment(): unknown {
  if (!currentAdmission.getStore()?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  const attachment = readSqliteWorkerOperationAdmissionAttachment();
  if (attachment === undefined) {
    throw new SqliteWorkerError("SQLite operation attachment is unavailable", "unavailable");
  }
  return attachment;
}
