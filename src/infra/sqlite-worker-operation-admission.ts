import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-errors.js";
import { sqlPublicationAnchor, type PostgresSqlConnection } from "./sql-connection.js";
import {
  captureSqliteDatabaseAdmissions,
  createSqliteDatabaseAdmissionCursor,
  installSqliteDatabaseAdmissions,
  prepareSqliteDatabaseAdmission,
  readSqliteDatabaseAdmissions,
  retainSqliteDatabaseAdmissionLocation,
  type SqliteDatabaseAdmissionCursor,
} from "./sqlite-database-admission.js";
import {
  readSqliteWorkerMonotonicNs,
  SqliteWorkerError,
  type SqliteWorkerAdmissionRequest,
  type SqliteWorkerExecutionAuthority,
} from "./sqlite-worker-contract.js";
import {
  SQLITE_COLD_ADMISSION_PENDING,
  exchangeDatabaseAdmissions,
  getSqliteDatabaseAdmissionUpstream,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-worker-database-admission-relay.js";
import {
  captureSqliteWorkerCommitReceipt,
  deferSqliteWorkerNativeCommitReceipt,
  currentSqliteWorkerOperationAdmission as currentAdmission,
  readNativeCommitReceipt,
  type CapturedSqliteWorkerCommitReceipt,
  type NativeCommitReceipt,
  type RetainedWorkerTransactionAdmission,
  type SqliteWorkerNativeSettlement,
  type SqliteWorkerNativeSettlementOwner,
} from "./sqlite-worker-operation-settlement.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-writer-admission-client.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";

export type { SqliteWorkerAdmissionRequest } from "./sqlite-worker-contract.js";
export { requestSqliteWorkerOperationAdmission } from "./sqlite-writer-admission-client.js";
export {
  withSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmissionAsync,
} from "./sqlite-worker-operation-scope.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;
const TIMED_OUT = 3;

type AdmissionFailureSource = "authority" | "domain" | "protocol";
type DatabaseAuthority = {
  /** Canonical identity captured when the database owner was admitted. */
  databasePath: string;
  /** Only the broker can identify an initial open of its captured primary database. */
  coldOpenPath?: string;
  assertRequest?(): void;
  assertAccess(): void;
  assertCreate?(databasePath: string): void;
  acquireSchema(): { assertCurrent(): void; release(): void };
};

export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly port: MessagePort;
  readonly attachment?: { value: unknown };
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

// Source and bundled callers can share one admission object in the same process.
const executionAuthorities = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWorkerExecutionAuthorities"),
  () => new WeakMap<SqliteWorkerOperationAdmission, SqliteWorkerExecutionAuthority>(),
);
const databaseAdmissionCursors = new WeakMap<
  SqliteWorkerOperationAdmission,
  { cursor: SqliteDatabaseAdmissionCursor; reset(): SqliteDatabaseAdmissionCursor }
>();

export function bindSqliteWorkerDatabaseAdmissionCursor(
  admission: SqliteWorkerOperationAdmission,
  cursor: SqliteDatabaseAdmissionCursor,
  reset: () => SqliteDatabaseAdmissionCursor,
): void {
  databaseAdmissionCursors.set(admission, { cursor, reset });
}

export function bindSqliteWorkerExecutionAuthority(
  admission: SqliteWorkerOperationAdmission,
  authority: SqliteWorkerExecutionAuthority,
): void {
  if (executionAuthorities.has(admission)) {
    throw new SqliteWorkerError("SQLite execution authority is already bound", "closed");
  }
  executionAuthorities.set(admission, Object.freeze(authority));
}

export function readSqliteWorkerExecutionAuthority(
  admission: SqliteWorkerOperationAdmission,
): SqliteWorkerExecutionAuthority | undefined {
  return executionAuthorities.get(admission);
}

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
export const createSqliteWorkerOperationAdmission = (
  admit: AdmissionHandler,
  attachment?: unknown,
): SqliteWorkerOperationAdmission => createOperationAdmission(admit, attachment);

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
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const decisions = new Set<Int32Array>();
  let databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let started = false;
  let observeRequest: ((request: SqliteWorkerAdmissionRequest) => void) | undefined;
  const commitObservers: CommitObserver[] = [];
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
  ) => recordFailure(new SqliteWorkerError(`SQLite worker ${kind} is invalid`, code), "protocol");
  const installCommitted = (receipt: NativeCommitReceipt): void => {
    // Each private port delivers receipts in order; repeated receipts remain idempotent.
    if (nativeReceipt && receipt.sequence <= nativeReceipt.sequence) {
      return;
    }
    nativeReceipt = receipt;
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
        "protocol",
      );
    } finally {
      observingCommit = false;
    }
  };
  const receive = (message: unknown) => {
    recordWorkerMessage(
      isRecord(message) && message.kind === "sqlite-database-admissions"
        ? "admission"
        : "authority",
      "from_worker",
      isRecord(message) && typeof message.payloadBytes === "number"
        ? message.payloadBytes
        : undefined,
    );
    started = true;
    if (isRecord(message) && message.kind === "sqlite-database-admissions") {
      if (
        !(message.port instanceof MessagePort) ||
        !(message.decision instanceof SharedArrayBuffer) ||
        message.decision.byteLength !== Int32Array.BYTES_PER_ELEMENT ||
        (message.location !== undefined && typeof message.location !== "string") ||
        (message.deadlineAtMs !== undefined &&
          (typeof message.deadlineAtMs !== "number" || !Number.isFinite(message.deadlineAtMs))) ||
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
      const deadlineAtMs = message.deadlineAtMs;
      const assertWaiting = () => {
        if (
          Atomics.load(decision, 0) !== REQUESTED ||
          (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs)
        ) {
          throw new SqliteWorkerError("SQLite admission requester stopped waiting", "unavailable");
        }
      };
      let coldOpenPath: string | undefined;
      try {
        assertWaiting();
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
            if (
              authority.coldOpenPath &&
              resolveIdentityPathViaExistingAncestorSync(authority.coldOpenPath) ===
                creationLocation
            ) {
              coldOpenPath = authority.coldOpenPath;
            }
            inOwnerContext(() => {
              authority.assertRequest?.();
              authority.assertAccess();
              assertCreate(creationLocation);
            });
            coldOpenPath = undefined;
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
            withSqliteDatabaseAdmissionWait(
              {
                deadlineAtMs,
                assertActive: assertWaiting,
              },
              () =>
                exchangeDatabaseAdmissions(
                  upstream.port,
                  admissions,
                  location,
                  create ? "admitted" : undefined,
                ),
            ),
          );
        } else if (location) {
          try {
            assertWaiting();
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
          message.location === undefined && admissions.length === 0
            ? undefined
            : { location: message.location, admissions };
        const cursor = databaseAdmissionCursors.get(admission);
        const reply = captureSqliteDatabaseAdmissions(
          cursor?.cursor ?? databaseAdmissionCursor,
          scope,
        );
        message.port.postMessage(reply, []);
        recordWorkerMessage("admission", "to_worker");
        Atomics.compareExchange(decision, 0, REQUESTED, GRANTED);
      } catch (error) {
        const cursor = databaseAdmissionCursors.get(admission);
        if (cursor) {
          cursor.cursor = cursor.reset();
        } else {
          databaseAdmissionCursor = createSqliteDatabaseAdmissionCursor();
        }
        if (
          error instanceof StateDatabaseAdmissionPendingError &&
          error.databasePath === coldOpenPath
        ) {
          // Nothing was created: preserve the worker cold-open owner's existing
          // bounded wait rather than poisoning this operation as a protocol failure.
          Atomics.store(decision, 0, SQLITE_COLD_ADMISSION_PENDING);
        } else {
          recordFailure(error, "protocol");
          Atomics.store(decision, 0, REFUSED);
        }
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
        (value.committed !== undefined && !receipt)
      ) {
        invalidProtocol("native settlement");
        return;
      }
      if (receipt) {
        installCommitted(receipt);
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
          authority.assertAccess();
          authority.lease.assertCurrent();
          grant();
        });
      } else {
        source = "domain";
        inOwnerContext(admit, request, grant);
      }
    } catch (error) {
      if (
        error instanceof StateDatabaseAdmissionPendingError &&
        databaseAuthority?.coldOpenPath === error.databasePath &&
        !databaseAuthority.lease &&
        request.stage === "prepare" &&
        isRecord(request.facts) &&
        request.facts.kind === "schema-maintenance" &&
        typeof request.facts.databasePath === "string" &&
        resolveIdentityPathViaExistingAncestorSync(request.facts.databasePath) ===
          databaseAuthority.databasePath
      ) {
        // No schema lease or body has begun; let the cold-open owner's bounded
        // wait handle another process creating this database first.
        if (
          Atomics.compareExchange(decision, 0, REQUESTED, SQLITE_COLD_ADMISSION_PENDING) ===
          REQUESTED
        ) {
          Atomics.notify(decision, 0);
        }
      } else {
        refuse(decision, error, source);
      }
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
  port1.on("message", receive).unref();
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
    attachment: attachment === undefined ? undefined : { value: attachment },
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
      databaseAuthority = { ...authority };
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
    if (closed || started) {
      throw new SqliteWorkerError("SQLite commit observation is closed or started", "closed");
    }
    commitObservers.push(observer);
  });
  return admission;
}

/** Record facts only after the real transaction commits, before native settlement is announced. */
export function deferSqliteWorkerCommitReceipt(
  database: DatabaseSync | PostgresSqlConnection,
  facts: unknown,
  delivery: "commit" | "settlement" = "commit",
): void {
  const scope = currentAdmission.getStore();
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
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite receipt requires its retained admission", "unavailable");
  }
  deferSqliteWorkerNativeCommitReceipt(scope.owner, database, captured, delivery);
}

/** A typed fenced write cannot commit without its destination owner's settlement evidence. */
export function assertSqliteWorkerCommitReceiptPending(
  database: DatabaseSync | PostgresSqlConnection,
): void {
  const scope = currentAdmission.getStore();
  if (!scope?.active || !scope.owner.pendingReceipts?.get(sqlPublicationAnchor(database))) {
    throw new SqliteWorkerError(
      "SQLite source fence requires a destination commit receipt",
      "closed",
    );
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

/** Require owner-prepared data carried by this operation's command envelope. */
export function takeSqliteWorkerOperationAdmissionAttachment(): unknown {
  const scope = currentAdmission.getStore();
  if (!scope?.active) {
    throw new SqliteWorkerError("SQLite operation requires its retained admission", "unavailable");
  }
  if (!scope.owner.attachment) {
    throw new SqliteWorkerError("SQLite operation attachment is unavailable", "unavailable");
  }
  return scope.owner.attachment.value;
}
