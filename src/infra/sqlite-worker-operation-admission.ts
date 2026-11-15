import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, type MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  resolveIdentityPathViaExistingAncestor,
  resolveIdentityPathViaExistingAncestorSync,
} from "./boundary-path.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-errors.js";
import {
  installSqliteDatabaseAdmissions,
  prepareSqliteDatabaseAdmission,
  prepareSqliteDatabaseAdmissionAsync,
  retainPreparedSqliteDatabaseAdmissionLocation,
  readSqliteDatabaseAdmissions,
  retainSqliteDatabaseAdmissionLocation,
} from "./sqlite-database-admission.js";
import {
  readSqliteWorkerAdmissionDecision,
  SqliteWorkerError,
  type SqliteWorkerAdmissionRequest,
  type SqliteWorkerAdmissionHandler as AdmissionHandler,
  type SqliteWorkerDatabaseAuthority as DatabaseAuthority,
  type SqliteWorkerExecutionAuthority,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import {
  SQLITE_COLD_ADMISSION_PENDING,
  createSqliteDatabaseAdmissionReplies,
  exchangeDatabaseAdmissions,
  getSqliteDatabaseAdmissionUpstream,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-worker-database-admission-relay.js";
import {
  createSqliteWorkerNativeReceiptOwner,
  type RetainedWorkerTransactionAdmission,
  type SqliteWorkerNativeSettlementOwner,
} from "./sqlite-worker-operation-settlement.js";
import { recordWorkerMessage } from "./worker-message-metrics.js";

export {
  deferSqliteWorkerCommitReceipt,
  deferCapturedSqliteWorkerCommitReceipt,
  assertSqliteWorkerCommitReceiptPending,
} from "./sqlite-worker-operation-settlement.js";
export type { SqliteWorkerAdmissionRequest } from "./sqlite-worker-contract.js";
export { requestSqliteWorkerOperationAdmission } from "./sqlite-writer-admission-client.js";
export {
  withSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmissionAsync,
  requestSqliteWorkerSchemaMaintenance,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "./sqlite-worker-operation-scope.js";

const REQUESTED = 0;
const GRANTED = 1;
const REFUSED = 2;

type AdmissionFailureSource = "authority" | "domain" | "protocol";
export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly port: MessagePort;
  requestClass?: string; // Broker-owned telemetry, never authority.
  readonly attachment?: { value: unknown };
  readonly failure: unknown;
  readonly failureSource: AdmissionFailureSource | undefined;
  readonly cleanupFailures: readonly unknown[];
  observeRequests(observer: (request: SqliteWorkerAdmissionRequest) => void): void;
  service(): void;
  finish(outcome?: "not-entered"): void | Promise<void>;
  bindDatabaseAuthority(authority: DatabaseAuthority): void;
};

export type SqliteWorkerAdmissionFactory = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
  databaseIdentity?: SqliteWorkerRequest["databaseIdentity"];
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

/** The optional continuation runs under live host authority before releasing the native writer. */
export const createSqliteWorkerOperationAdmission = (
  admit: AdmissionHandler,
  attachment?: unknown,
  prepare?: (request: SqliteWorkerAdmissionRequest) => Promise<void>,
) => createOperationAdmission(admit, attachment, undefined, prepare);

/** Task lifetime channels relay a broker's creation grant without acquiring database authority. */
export function createSqliteDatabaseAdmissionRelay(assertCurrent: () => void) {
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
  prepare?: (request: SqliteWorkerAdmissionRequest) => Promise<void>,
) {
  // Closed Node ports retain their creation context; only the carrier is context-free.
  const { port1, port2 } = runInDetachedAsyncContext(() => new MessageChannel());
  let callbacks:
    | {
        admit: typeof admit;
        prepare: typeof prepare;
        assertRelayCurrent: typeof assertRelayCurrent;
        inOwnerContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
      }
    | undefined = {
    admit,
    prepare,
    assertRelayCurrent,
    inOwnerContext: AsyncLocalStorage.snapshot(),
  };
  // Only accepted broker creation attaches filesystem completion to its decision.
  const decisions = new Map<Int32Array, Promise<void> | undefined>();
  let finishing: Promise<void> | undefined;
  const databaseReplies = createSqliteDatabaseAdmissionReplies();
  const cleanupFailures: unknown[] = [];
  let closed = false;
  let started = false;
  let observeRequest: ((request: SqliteWorkerAdmissionRequest) => void) | undefined;
  let failure: { error: unknown; source: AdmissionFailureSource } | undefined;
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
  const receipts = createSqliteWorkerNativeReceiptOwner(
    (operation) => callbacks?.inOwnerContext(operation),
    (error) => recordFailure(error, "protocol"),
  );
  const receive = (wire: unknown) => {
    // Reentrant finish releases the owner record, not an already-running callback frame.
    const currentCallbacks = callbacks;
    const metric = isRecord(wire) ? wire : undefined;
    recordWorkerMessage(
      metric?.kind === "sqlite-database-admissions" ? "admission" : "authority",
      "from_worker",
      typeof metric?.payloadBytes === "number" ? metric.payloadBytes : undefined,
      admission.requestClass,
    );
    started = true;
    if (metric?.kind === "sqlite-database-admissions") {
      const received = databaseReplies.receive(
        metric,
        admission,
        currentCallbacks?.inOwnerContext,
        (error) => recordFailure(error, "protocol"),
      );
      if (!received) {
        return;
      }
      const {
        message,
        decision,
        deadlineAtMs,
        observedLocation,
        assertWaiting,
        publishFacts,
        failFacts,
        finishFacts,
      } = received;
      let coldOpenPath: string | undefined;
      let preparing = false;
      try {
        assertWaiting();
        if (closed || !currentCallbacks) {
          throw new SqliteWorkerError("SQLite worker admission is closed", "closed");
        }
        const assertRelayCreation =
          message.create === "admitted" ? currentCallbacks.assertRelayCurrent : undefined;
        if (message.create === "admitted" && !assertRelayCreation) {
          throw new SqliteWorkerError("SQLite creation relay is not admitted", "closed");
        }
        const admissions = readSqliteDatabaseAdmissions(message.admissions);
        if (!admissions) {
          throw new SqliteWorkerError("SQLite admission facts request is invalid", "unavailable");
        }
        // The paired registry owns these records; sharing them grants no database authority.
        installSqliteDatabaseAdmissions(admissions);
        const authority = databaseAuthority;
        const expected = authority?.databaseIdentity;
        const expectedIdentity =
          expected &&
          (message.location === expected.databasePath ||
            message.location === authority.databasePath)
            ? expected
            : undefined;
        const upstream = getSqliteDatabaseAdmissionUpstream();
        const prepared =
          !message.create &&
          (!message.location ||
            retainPreparedSqliteDatabaseAdmissionLocation(
              message.location,
              expectedIdentity,
              observedLocation,
            ));
        if (!upstream && prepared) {
          publishFacts(admissions);
          return;
        }
        if (
          !upstream &&
          message.location &&
          (!message.create || authority || assertRelayCreation)
        ) {
          const location = message.location;
          const createRequest = message.create;
          const assertCurrent = () => {
            assertWaiting();
            if (closed || callbacks !== currentCallbacks || databaseAuthority !== authority) {
              throw new SqliteWorkerError("SQLite worker admission is closed", "closed");
            }
            currentCallbacks.inOwnerContext(() => {
              authority?.assertRequest?.();
              assertRelayCreation?.();
            });
          };
          decisions.set(decision, undefined);
          preparing = true;
          void currentCallbacks.inOwnerContext(async () => {
            try {
              await prepareSqliteDatabaseAdmissionAsync({
                location,
                expectedIdentity,
                observedLocation,
                assertCurrent,
                ...(createRequest
                  ? {
                      create: {
                        async authorize(creationLocation: string) {
                          assertCurrent();
                          if (createRequest === "admitted") {
                            return;
                          }
                          const assertCreate = authority?.assertCreate?.bind(authority);
                          const prepareCreate = authority?.prepareCreate?.bind(authority);
                          if (!authority || !assertCreate) {
                            throw new SqliteWorkerError(
                              "SQLite worker file creation requires host authority",
                              "closed",
                            );
                          }
                          if (
                            authority.coldOpenPath &&
                            (await resolveIdentityPathViaExistingAncestor(
                              authority.coldOpenPath,
                            )) === creationLocation
                          ) {
                            coldOpenPath = authority.coldOpenPath;
                          }
                          assertCurrent();
                          currentCallbacks.inOwnerContext(() => authority.assertAccess());
                          if (prepareCreate) {
                            await currentCallbacks.inOwnerContext(prepareCreate, creationLocation);
                          } else {
                            currentCallbacks.inOwnerContext(assertCreate, creationLocation);
                          }
                          assertCurrent();
                          currentCallbacks.inOwnerContext(() => authority.assertAccess());
                          coldOpenPath = undefined;
                        },
                        retain(completion: Promise<void>) {
                          // The same waiting decision now also owns the submitted host effect.
                          decisions.set(decision, completion);
                          void completion.catch((error: unknown) => {
                            if (!cleanupFailures.includes(error)) {
                              cleanupFailures.push(error);
                            }
                          });
                        },
                      },
                    }
                  : {}),
              });
              assertCurrent();
              publishFacts(admissions);
            } catch (error) {
              failFacts(error, coldOpenPath);
            } finally {
              decisions.delete(decision);
              finishFacts();
            }
          });
          return;
        }
        let location = message.location;
        let create = false;
        if (
          message.location &&
          message.create &&
          !prepareSqliteDatabaseAdmission(message.location)
        ) {
          location = resolveIdentityPathViaExistingAncestorSync(message.location);
          const creationLocation = location;
          const creationAuthority = databaseAuthority;
          const assertCreate = creationAuthority?.assertCreate?.bind(creationAuthority);
          if (message.create === "admitted") {
            create = true;
          } else if (creationAuthority && assertCreate) {
            if (
              creationAuthority.coldOpenPath &&
              resolveIdentityPathViaExistingAncestorSync(creationAuthority.coldOpenPath) ===
                creationLocation
            ) {
              coldOpenPath = creationAuthority.coldOpenPath;
            }
            currentCallbacks.inOwnerContext(() => {
              creationAuthority.assertRequest?.();
              creationAuthority.assertAccess();
              assertCreate(creationLocation);
            });
            coldOpenPath = undefined;
            create = true;
          }
        }
        if (create && assertRelayCreation) {
          currentCallbacks.inOwnerContext(assertRelayCreation);
        }
        if (closed) {
          throw new SqliteWorkerError("SQLite worker admission is closed", "closed");
        }
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
                  observedLocation,
                ),
            ),
          );
        } else if (location) {
          try {
            assertWaiting();
            if (create) {
              prepareSqliteDatabaseAdmission(location, { create: true });
            }
            const identity = databaseAuthority?.databaseIdentity;
            retainSqliteDatabaseAdmissionLocation(
              location,
              identity &&
                (location === identity.databasePath || location === databaseAuthority?.databasePath)
                ? identity
                : undefined,
              observedLocation,
            );
          } catch (error) {
            if (!isRecord(error) || error.code !== "ENOENT") {
              throw error;
            }
          }
        }
        publishFacts(admissions);
      } catch (error) {
        failFacts(error, coldOpenPath);
      } finally {
        if (!preparing) {
          finishFacts();
        }
      }
      return;
    }
    if (receipts.receive(wire)) {
      return;
    }
    const receivedDecision = readSqliteWorkerAdmissionDecision(wire);
    if (!receivedDecision) {
      recordFailure(
        new SqliteWorkerError("SQLite worker admission request is invalid", "unavailable"),
        "protocol",
      );
      return;
    }
    const { decision, expired, request } = receivedDecision;
    if (expired()) {
      // The worker has abandoned this request; even policy preparation must not run late.
      return;
    }
    decisions.set(decision, undefined);
    try {
      // A queued fact may describe an earlier COMMIT; observing it never grants more work.
      if (observeRequest) {
        currentCallbacks?.inOwnerContext(observeRequest, request);
      }
    } catch (error) {
      refuse(decision, error, "domain");
      return;
    }
    if (closed || !currentCallbacks) {
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
        currentCallbacks.inOwnerContext(() => databaseAuthority?.assertAccess());
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
    let preparing = false;
    const finishDecision = () => {
      decisions.delete(decision);
      if (Atomics.load(decision, 0) === REQUESTED) {
        refuse(
          decision,
          new SqliteWorkerError("SQLite worker admission was not granted", "closed"),
          "domain",
        );
      }
    };
    let source: AdmissionFailureSource = "authority";
    try {
      currentCallbacks.inOwnerContext(() => {
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
        currentCallbacks.inOwnerContext(() => {
          authority.lease ??= authority.acquireSchema();
          authority.assertAccess();
          authority.lease.assertCurrent();
          grant();
        });
      } else {
        source = "domain";
        const prepareRequest = currentCallbacks.prepare;
        if (prepareRequest) {
          preparing = true;
          void (async () => {
            try {
              await currentCallbacks.inOwnerContext(prepareRequest, request);
              if (!closed && !expired() && Atomics.load(decision, 0) === REQUESTED) {
                currentCallbacks.inOwnerContext(currentCallbacks.admit, request, grant);
              }
            } catch (error) {
              refuse(decision, error, "domain");
            } finally {
              finishDecision();
            }
          })();
          return;
        }
        currentCallbacks.inOwnerContext(currentCallbacks.admit, request, grant);
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
    } finally {
      // Async preparation retains its decision so finish() can refuse it immediately.
      if (!preparing) {
        finishDecision();
      }
    }
  };
  const receiveInOwnerContext = (message: unknown) =>
    callbacks ? callbacks.inOwnerContext(receive, message) : receive(message);
  port1.on("message", receiveInOwnerContext).unref();
  const drain = (first: ReturnType<typeof receiveMessageOnPort>) => {
    for (let queued = first; queued; queued = receiveMessageOnPort(port1)) {
      receive(queued.message);
    }
  };
  const service = () => {
    // Observers may inspect retained facts without recursively publishing the next receipt.
    if (receipts.observingCommit) {
      return;
    }
    const queued = receiveMessageOnPort(port1);
    if (queued) {
      // Callbacks restore this frame; each message still rechecks live authority.
      return callbacks ? callbacks.inOwnerContext(drain, queued) : drain(queued);
    }
  };
  const admission: SqliteWorkerOperationAdmission & {
    /** Only untouched construction can finish synchronously; started work keeps its normal join. */
    abortConstruction(): void;
  } = {
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
      return receipts.committed;
    },
    get settlement() {
      return receipts.settlement;
    },
    waitForSettlement(deadlineMs) {
      while (true) {
        service();
        if (failure !== undefined) {
          throw toErrorObject(failure.error, "SQLite worker admission failed");
        }
        if (receipts.settlement?.kind === "completed") {
          return receipts.settlement;
        }
        const remaining = deadlineMs - performance.now();
        if (receipts.settlement?.kind === "unknown" || closed || remaining <= 0) {
          throw new SqliteWorkerError(
            "SQLite worker native settlement is unknown",
            "outcome-unknown",
          );
        }
        Atomics.wait(waiting, 0, 0, Math.min(5, remaining));
      }
    },
    service,
    abortConstruction() {
      if (started) {
        throw new SqliteWorkerError(
          "SQLite admission construction has already received work",
          "closed",
        );
      }
      // Finish closes before draining, so queued requests cannot submit a new CREATE.
      // Use the actual method so installed finish observers retain their existing order.
      const completion = admission.finish();
      if (completion !== undefined) {
        throw new SqliteWorkerError(
          "SQLite unstarted admission cleanup did not finish synchronously",
          "closed",
        );
      }
    },
    finish(outcome) {
      if (finishing) {
        return finishing;
      }
      closed = true;
      // Receipts remain observable; late requests can no longer obtain authority.
      service();
      const acceptedCreations = [...decisions.values()].filter(
        (pending): pending is Promise<void> => pending !== undefined,
      );
      for (const decision of decisions.keys()) {
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
      const release = () => {
        receipts.finish(outcome);
        observeRequest = undefined;
        if (databaseAuthority?.lease) {
          try {
            databaseAuthority.lease.release();
            databaseAuthority.lease = undefined;
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
        if (!databaseAuthority?.lease) {
          databaseAuthority = undefined;
        }
        // Recovery retains receipts, not the finished request's callbacks or async context.
        callbacks = undefined;
        databaseReplies.release(admission);
      };
      if (acceptedCreations.length === 0) {
        release();
        return undefined;
      }
      finishing = Promise.allSettled(acceptedCreations)
        .then(release)
        .finally(() => {
          finishing = undefined;
        });
      return finishing;
    },
  };
  commitObserverBindings.set(admission, (observer) => {
    if (closed || started) {
      throw new SqliteWorkerError("SQLite commit observation is closed or started", "closed");
    }
    receipts.observe(observer);
  });
  return admission;
}
