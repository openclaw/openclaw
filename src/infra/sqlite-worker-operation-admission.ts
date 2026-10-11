import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  MessageChannel,
  MessagePort,
  receiveMessageOnPort,
  type Transferable,
} from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import {
  captureSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  installSqliteDatabaseAdmissions,
  prepareSqliteDatabaseAdmission,
  readSqliteDatabaseAdmissions,
  retainSqliteDatabaseAdmissionLocation,
  withSqliteDatabaseAdmissionExchange,
} from "./sqlite-database-admission.js";
import { currentSqliteOperationTiming } from "./sqlite-reader-lifecycle.js";
import { SqliteWorkerAdmissionTimeoutError, SqliteWorkerError } from "./sqlite-worker-contract.js";
import {
  exchangeDatabaseAdmissions,
  exchangeSqliteDatabaseAdmissions,
  getSqliteDatabaseAdmissionUpstream,
} from "./sqlite-worker-database-admission-relay.js";
import {
  deferSqliteWorkerNativeCommitReceipt,
  currentSqliteWorkerOperationAdmission as currentAdmission,
  type WorkerAdmissionScope,
  readNativeCommitReceipt,
  type NativeCommitReceipt,
  type RetainedWorkerTransactionAdmission,
  type SqliteWorkerNativeSettlement,
  type SqliteWorkerNativeSettlementOwner,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-settlement.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;
const TIMED_OUT = 3;

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
  /** Opt-in wait budget in milliseconds; omission retains the live-owner wait. */
  deadlineMs?: number;
};

type AdmissionFailureSource = "authority" | "domain" | "protocol";
type DatabaseAuthority = {
  databasePath: string;
  assertRequest?(): void;
  assertAccess(): void;
  assertCreate?(databasePath: string): void;
  acquireSchema(): { assertCurrent(): void; release(): void };
};

export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly port: MessagePort;
  readonly failure: unknown;
  readonly failureSource: AdmissionFailureSource | undefined;
  readonly cleanupFailures: readonly unknown[];
  observeRequests(observer: (request: SqliteWorkerAdmissionRequest) => void): void;
  service(): void;
  finish(): void;
  bindDatabaseAuthority(authority: DatabaseAuthority): void;
};

export type SqliteWorkerAdmissionFactory = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
};

type CommitObserver = (committed: { facts: unknown }) => void;
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

type AdmissionHandler = (
  request: SqliteWorkerAdmissionRequest,
  grant: (beforeRelease?: () => void) => boolean,
) => void;

/** The optional continuation runs under live host authority before releasing the native writer. */
export function createSqliteWorkerOperationAdmission(
  admit: AdmissionHandler,
  attachment?: unknown,
): SqliteWorkerOperationAdmission {
  return createOperationAdmission(admit, attachment);
}

/** Task lifetime channels relay a broker's creation grant without acquiring database authority. */
export function createSqliteDatabaseAdmissionRelay(
  assertCurrent: () => void,
): SqliteWorkerOperationAdmission {
  return createOperationAdmission(
    () => {
      throw new Error("Worker format facts do not grant database authority");
    },
    undefined,
    assertCurrent,
  );
}

function createOperationAdmission(
  admit: AdmissionHandler,
  attachment?: unknown,
  assertRelayCurrent?: () => void,
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
  const databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor();
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
    | (DatabaseAuthority & { lease?: ReturnType<DatabaseAuthority["acquireSchema"]> })
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
  const invalidProtocol = (
    kind: "commit receipt" | "native settlement" | "admission request",
    code: "outcome-unknown" | "unavailable" = "outcome-unknown",
  ) => {
    recordFailure(new SqliteWorkerError(`SQLite worker ${kind} is invalid`, code), "protocol");
  };
  const installCommitted = (receipt: NativeCommitReceipt): boolean => {
    if (nativeReceipt) {
      if (
        receipt.operationId !== nativeReceipt.operationId ||
        (receipt.sequence === nativeReceipt.sequence && !isDeepStrictEqual(nativeReceipt, receipt))
      ) {
        invalidProtocol("commit receipt");
        return false;
      }
      if (receipt.sequence <= nativeReceipt.sequence) {
        return true;
      }
    }
    if (settlement) {
      invalidProtocol("commit receipt");
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
    if (isRecord(message) && message.kind === "sqlite-database-admissions") {
      if (
        !(message.port instanceof MessagePort) ||
        !(message.decision instanceof SharedArrayBuffer) ||
        message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
        (message.location !== undefined && typeof message.location !== "string") ||
        (message.create !== undefined &&
          typeof message.create !== "boolean" &&
          message.create !== "admitted")
      ) {
        recordFailure(
          new SqliteWorkerError("SQLite admission facts request is invalid", "unavailable"),
          "protocol",
        );
        return;
      }
      const decision = new Int32Array(message.decision);
      try {
        if (closed) {
          throw new SqliteWorkerError("SQLite worker admission is closed", "closed");
        }
        const assertRelayCreation = message.create === "admitted" ? assertRelayCurrent : undefined;
        if (message.create === "admitted" && !assertRelayCreation) {
          throw new SqliteWorkerError("SQLite creation relay is not admitted", "closed");
        }
        const admissions = readSqliteDatabaseAdmissions(message.admissions);
        if (!admissions) {
          throw new SqliteWorkerError("SQLite admission facts request is invalid", "unavailable");
        }
        // The paired registry owns these records; sharing them grants no database authority.
        installSqliteDatabaseAdmissions(admissions);
        let location = message.location;
        let create = false;
        if (
          message.location &&
          message.create &&
          !prepareSqliteDatabaseAdmission(message.location)
        ) {
          location = resolveIdentityPathViaExistingAncestorSync(message.location);
          const creationLocation = location;
          const authority = databaseAuthority;
          const assertCreate = authority?.assertCreate?.bind(authority);
          if (message.create === "admitted") {
            create = true;
          } else if (authority && assertCreate) {
            inOwnerContext(() => {
              authority.assertRequest?.();
              authority.assertAccess();
              assertCreate(creationLocation);
            });
            create = true;
          }
        }
        if (create) {
          assertRelayCreation?.();
        }
        if (closed) {
          throw new SqliteWorkerError("SQLite worker admission is closed", "closed");
        }
        const upstream = getSqliteDatabaseAdmissionUpstream();
        if (upstream) {
          if (upstream.closed) {
            throw new SqliteWorkerError("SQLite admission upstream is closed", "closed");
          }
          // A descendant publication must reach the descriptor owner before its sibling opens.
          installSqliteDatabaseAdmissions(
            exchangeDatabaseAdmissions(
              upstream.port,
              admissions,
              location,
              create ? "admitted" : undefined,
            ),
          );
        } else if (location) {
          try {
            if (create) {
              prepareSqliteDatabaseAdmission(location, { create: true });
            }
            retainSqliteDatabaseAdmissionLocation(location);
          } catch (error) {
            if (!isRecord(error) || error.code !== "ENOENT") {
              throw error;
            }
          }
        }
        const scope =
          message.location === undefined ? undefined : { location: message.location, admissions };
        const reply = captureSqliteDatabaseAdmissions(databaseAdmissionCursor, scope);
        message.port.postMessage(reply, []);
        Atomics.store(decision, 0, GRANTED);
      } catch (error) {
        recordFailure(error, "protocol");
        Atomics.store(decision, 0, REFUSED);
      } finally {
        message.port.close();
        Atomics.notify(decision, 0);
      }
      return;
    }
    if (isRecord(message) && message.kind === "native-commit") {
      const receipt = readNativeCommitReceipt(message.committed);
      if (!receipt) {
        invalidProtocol("commit receipt");
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
        invalidProtocol("native settlement");
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
      invalidProtocol("admission request", "unavailable");
      return;
    }
    const decision = new Int32Array(message.decision);
    const expired = () => {
      if (typeof message.deadlineNs === "bigint" && process.hrtime.bigint() >= message.deadlineNs) {
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
    if (expired()) {
      // The worker has abandoned this request; even policy preparation must not run late.
      return;
    }
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
      if (closed || expired() || Atomics.load(decision, 0) !== REQUESTED) {
        return false;
      }
      // Domain admission can reenter owner lifecycle before handing the native writer its grant.
      try {
        inOwnerContext(() => databaseAuthority?.assertAccess());
      } catch (error) {
        refuse(decision, error, "authority");
        return false;
      }
      if (closed || expired() || Atomics.load(decision, 0) !== REQUESTED) {
        return false;
      }
      beforeRelease?.();
      if (expired()) {
        return false;
      }
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

/** Install only the private port belonging to the broker's currently executing operation. */
export function withSqliteWorkerOperationAdmission<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T,
): T {
  const scope = { owner, port: owner.port, active: true };
  try {
    return runSqliteWorkerAdmissionScope(scope, operation);
  } finally {
    scope.active = false;
  }
}

/** Async factories and cleanup retain the same grant until their accepted work settles. */
export async function withSqliteWorkerOperationAdmissionAsync<T>(
  owner: SqliteWorkerOperationContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  const scope = { owner, port: owner.port, active: true };
  try {
    return await runSqliteWorkerAdmissionScope(scope, operation);
  } finally {
    scope.active = false;
  }
}

function runSqliteWorkerAdmissionScope<T>(scope: WorkerAdmissionScope, operation: () => T): T {
  return currentAdmission.run(scope, () =>
    withSqliteDatabaseAdmissionExchange((admissions, location, create) => {
      if (!scope.active) {
        const upstream = getSqliteDatabaseAdmissionUpstream();
        if (create || !upstream || upstream.closed) {
          throw new SqliteWorkerError(
            "SQLite facts require their retained admission",
            "unavailable",
          );
        }
        // Retained cleanup may publish facts; creation still needs the live grant.
        return exchangeDatabaseAdmissions(upstream.port, admissions, location);
      }
      return exchangeSqliteDatabaseAdmissions(scope.port, admissions, location, create);
    }, operation),
  );
}

/** Record facts only after the real transaction commits, before native settlement is announced. */
export function deferSqliteWorkerCommitReceipt(
  database: DatabaseSync,
  facts: unknown,
  delivery: "commit" | "settlement" = "commit",
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  deferSqliteWorkerNativeCommitReceipt(scope.owner, database, facts, delivery);
}

/** A typed fenced write cannot commit without its destination owner's settlement evidence. */
export function assertSqliteWorkerCommitReceiptPending(database: DatabaseSync): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active || !scope.owner.pendingReceipts?.get(database)) {
    throw new SqliteWorkerError(
      "SQLite source fence requires a destination commit receipt",
      "closed",
    );
  }
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
  if (scope.owner.sourceReservations) {
    throw new SqliteWorkerError("SQLite source reservations prohibit host admission", "closed");
  }
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const startedAt = Date.now();
  const deadlineNs =
    request.deadlineMs === undefined
      ? undefined
      : process.hrtime.bigint() + BigInt(request.deadlineMs) * 1_000_000n;
  scope.port.postMessage(
    {
      ...request,
      decision: decision.buffer,
      deadlineNs,
      ports: transferList.filter((value) => value instanceof MessagePort),
    },
    transferList,
  );
  // Cancellation revokes this request, never grants authority. Settlement still
  // joins native rollback before the broker releases operation custody.
  while (Atomics.load(decision, 0) === REQUESTED) {
    const remainingMs =
      deadlineNs === undefined ? undefined : Number(deadlineNs - process.hrtime.bigint()) / 1e6;
    if (remainingMs !== undefined && remainingMs <= 0) {
      Atomics.compareExchange(decision, 0, REQUESTED, TIMED_OUT);
    } else {
      Atomics.wait(decision, 0, REQUESTED, remainingMs);
    }
  }
  const timing = currentSqliteOperationTiming();
  if (timing) {
    timing.hostAdmissionWaitMs += Date.now() - startedAt;
  }
  if (Atomics.load(decision, 0) !== GRANTED) {
    const refusal =
      Atomics.load(decision, 0) === TIMED_OUT
        ? new SqliteWorkerAdmissionTimeoutError()
        : new SqliteWorkerError("SQLite transaction admission was refused", "closed");
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
