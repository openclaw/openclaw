import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { coerceErrorMessage, toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { withSqliteDatabaseAdmissionExchange } from "../infra/sqlite-database-admission.js";
import {
  isSqliteLockError,
  sqliteErrorCode,
  sqliteExtendedResultCode,
} from "../infra/sqlite-error-diagnostics.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { exchangeSqliteDatabaseAdmissions } from "../infra/sqlite-worker-database-admission-relay.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { openStatePostgresReadConnection } from "./openclaw-state-db-engine.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  leaseHeartbeatState as state,
  leaseHeartbeatStartupPhase as startupPhase,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  LEASE_CONTENTION_RETRY_MS,
  type LeaseHeartbeatLoss,
  type LeaseHeartbeatRenewalFailure,
  type LeaseHeartbeatReply,
  type LeaseHeartbeatParentMessage,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  createStateLeaseRenewalScheduler,
  type StateLeaseRenewal,
  type StateLeaseRenewalOutcome,
} from "./openclaw-state-lease-renewal.worker.js";
import {
  readOpenClawStateLeaseExpiry,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

type HeartbeatRegistration = { registration: LeaseHeartbeatWorkerData; port: MessagePort };
type HeartbeatDatabase = {
  database: EngineConnection;
  close: () => void;
  renewals: ReturnType<typeof createStateLeaseRenewalScheduler>;
  references: number;
};
const databases = new Map<string, HeartbeatDatabase>();

function startHeartbeat(
  params: LeaseHeartbeatWorkerData,
  port: MessagePort,
  primary = false,
): void {
  let retainedDatabase: HeartbeatDatabase | undefined;
  const databaseKey = JSON.stringify([params.path, params.expectedIdentity]);
  function withDatabaseAdmission<T>(operation: () => T): T {
    return withSqliteDatabaseAdmissionExchange(
      (admissions, location, create) =>
        exchangeSqliteDatabaseAdmissions(
          params.databaseAdmissionPort,
          admissions,
          location,
          create,
        ),
      operation,
    );
  }
  const shared = new BigInt64Array(params.shared);
  const renewalProgress = new BigInt64Array(params.renewalProgress);
  const completedRequest = new BigInt64Array(params.completedRequest);
  Atomics.store(shared, state.startupPhase, startupPhase["body-entry"]);
  function observeDurableExpiry(expiresAt: number | undefined) {
    Atomics.store(shared, state.expiresAt, BigInt(expiresAt ?? 0));
    return expiresAt;
  }
  function openHeartbeatDatabase() {
    // The parent's bound is a retry deadline, not ownership. Renewal below still
    // checks the exact current persisted owner/expiry before changing the row.
    const deadline = Date.now() + LEASE_HEARTBEAT_START_TIMEOUT_MS;
    const remaining = () =>
      Math.min(deadline, Number(Atomics.load(shared, state.expiresAt))) - Date.now();
    while (remaining() > 0 && Atomics.load(shared, state.status) === state.starting) {
      try {
        const postgres = openStatePostgresReadConnection(params.path, params.expectedIdentity);
        if (postgres) {
          return {
            database: postgres.database.db,
            close: () => {
              postgres.close();
            },
          };
        }
        const database = openTrackedStateDatabase(params.path, {
          existingOnly: true,
          expectedIdentity: params.expectedIdentity,
        });
        return { database, close: () => closeTrackedStateDatabase(database) };
      } catch (error) {
        if (!isSqliteLockError(error)) {
          throw error;
        }
      }
      Atomics.wait(
        shared,
        state.status,
        state.starting,
        Math.max(1, Math.min(LEASE_CONTENTION_RETRY_MS, remaining())),
      );
    }
    throw new Error("state lease heartbeat startup deadline expired or owner stopped");
  }
  let db: EngineConnection;
  let processOwner = params.processOwner;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const scheduledRenewal: StateLeaseRenewal = {
    identity: params.identity,
    leaseMs: params.leaseMs,
    intervalMs: params.heartbeatMs,
    execute: (operation) =>
      withRenewalProgress(() => {
        assertStateDatabaseAccessAllowed(params.path);
        return operation();
      }),
    complete: (outcome) =>
      runAutomatic(() => renewInWorker(false, "automatic-renewal", outcome), "automatic-renewal"),
  };
  const close = () => {
    if (closed) {
      return;
    }
    clearTimeout(heartbeat);
    retainedDatabase?.renewals.cancel(scheduledRenewal);
    try {
      if (retainedDatabase) {
        if (retainedDatabase.references === 1) {
          retainedDatabase.close();
          databases.delete(databaseKey);
        } else {
          retainedDatabase.references--;
        }
        retainedDatabase = undefined;
      }
    } catch (error) {
      port.postMessage({ startupError: coerceErrorMessage(error) }, []);
      return;
    }
    closed = true;
    params.databaseAdmissionPort.close();
    port.off("message", receiveMessage);
    if (primary) {
      port.postMessage({ closed: true }, []);
    } else {
      port.close();
    }
  };
  let attempt = 0;
  let firstLoss: LeaseHeartbeatLoss | undefined;
  const recordLoss = (loss: LeaseHeartbeatLoss) => {
    if (firstLoss || Atomics.load(shared, state.status) === state.closed) {
      return;
    }
    firstLoss = loss;
    port.postMessage({ loss } satisfies LeaseHeartbeatReply, []);
  };
  const lose = (loss: LeaseHeartbeatLoss) => {
    Atomics.compareExchange(shared, state.status, state.starting, state.lost);
    Atomics.compareExchange(shared, state.status, state.ready, state.lost);
    recordLoss(loss);
    Atomics.notify(shared, state.ack);
    close();
  };
  const renewInWorker = (
    explicit: boolean,
    path: LeaseHeartbeatLoss["path"],
    outcome?: StateLeaseRenewalOutcome,
  ): number | undefined => {
    if (Atomics.load(shared, state.status) >= state.closed) {
      return undefined;
    }
    let expiresAt: number | undefined;
    let contentionError: unknown;
    attempt += 1;
    try {
      if (outcome && "error" in outcome) {
        throw outcome.error;
      }
      // Native lookup can be slow; keep it outside write admission and startup readiness.
      if (
        processOwner?.identity.startedAt === null &&
        Atomics.load(shared, state.status) === state.ready
      ) {
        processOwner.identity.startedAt = getFileLockProcessStartTime(
          processOwner.identity.pid,
          processOwner.env,
        );
      }
      const renew = () =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            assertStateDatabaseAccessAllowed(params.path);
            if (Atomics.load(shared, state.status) >= state.closed) {
              return undefined;
            }
            return renewOpenClawStateLeaseInTransaction(
              db,
              params.identity,
              params.leaseMs,
              processOwner?.identity,
            );
          },
          { operationLabel: "state.lease.renew", logger: { warn() {} } },
        );
      expiresAt = outcome
        ? outcome.expiresAt
        : isPostgresSqlConnection(db)
          ? renew()
          : runWithSqliteBusyTimeout(db, 0, renew, { lockFailureReporting: "suppress" });
      if (expiresAt !== undefined) {
        Atomics.store(shared, state.lastRenewedAt, BigInt(expiresAt - params.leaseMs));
      }
      if (expiresAt !== undefined && processOwner?.identity.startedAt != null) {
        processOwner = undefined;
      }
    } catch (error) {
      if (!isSqliteLockError(error)) {
        port.postMessage(
          {
            name: error instanceof Error ? error.name : "Error",
            message: coerceErrorMessage(error),
            code: sqliteErrorCode(error),
            errcode: sqliteExtendedResultCode(error),
            attempt,
            elapsedMs: Date.now() - params.acquiredAt,
          } satisfies LeaseHeartbeatRenewalFailure,
          [],
        );
        if (explicit) {
          throw error;
        }
        lose({ path, outcome: "operation-error" });
        return undefined;
      }
      contentionError = error;
      expiresAt = readOpenClawStateLeaseExpiry(db, params.identity);
    }
    observeDurableExpiry(expiresAt);
    if (expiresAt === undefined) {
      if (!explicit) {
        lose({ path, outcome: "no-current-owned-unexpired-row" });
      }
      return undefined;
    }
    // Contention may delay renewal, but must never delay expiry detection by a
    // full heartbeat interval or authorize renewal after the persisted deadline.
    clearTimeout(heartbeat);
    retainedDatabase?.renewals.cancel(scheduledRenewal);
    if (
      contentionError === undefined &&
      processOwner === undefined &&
      (!params.deferActivation || Atomics.load(shared, state.status) === state.ready)
    ) {
      retainedDatabase?.renewals.schedule(scheduledRenewal, expiresAt);
      return expiresAt;
    }
    heartbeat = setTimeout(
      () => {
        if (params.deferActivation && Atomics.load(shared, state.status) === state.starting) {
          runAutomatic(activateHeartbeat, "activation");
        } else {
          runAutomatic(renew, "automatic-renewal");
        }
      },
      Math.max(
        1,
        Math.min(
          contentionError === undefined ? params.heartbeatMs : LEASE_CONTENTION_RETRY_MS,
          expiresAt - Date.now(),
        ),
      ),
    );
    heartbeat.unref();
    // A still-valid old expiry permits automatic retry, not renewal success.
    if (explicit && contentionError !== undefined) {
      throw toErrorObject(contentionError, "state lease heartbeat renewal was delayed");
    }
    return expiresAt;
  };

  // SQLite and native process lookup are synchronous on this worker. Publish only
  // occupancy; callers still require a fresh reply and check the durable owner.
  function withRenewalProgress<T>(operation: () => T): T {
    Atomics.add(renewalProgress, 0, 1n);
    Atomics.notify(shared, state.ack);
    try {
      return withDatabaseAdmission(operation);
    } finally {
      Atomics.add(renewalProgress, 0, 1n);
      Atomics.notify(shared, state.ack);
    }
  }
  const renew = (
    explicit = false,
    path: LeaseHeartbeatLoss["path"] = "automatic-renewal",
  ): number | undefined => withRenewalProgress(() => renewInWorker(explicit, path));

  function activateHeartbeat(): void {
    let expiresAt: number | undefined;
    try {
      Atomics.store(shared, state.startupPhase, startupPhase["initial-renew-start"]);
      expiresAt = renew(params.deferActivation === true, "activation");
      Atomics.store(shared, state.startupPhase, startupPhase["initial-renew-returned"]);
    } catch (error) {
      if (params.deferActivation && isSqliteLockError(error)) {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(
          () => runAutomatic(activateHeartbeat, "activation"),
          Math.max(
            1,
            Math.min(
              LEASE_CONTENTION_RETRY_MS,
              Number(Atomics.load(shared, state.expiresAt)) - Date.now(),
            ),
          ),
        );
        return;
      }
      lose({ path: "activation", outcome: "operation-error" });
      return;
    }
    if (expiresAt === undefined) {
      lose({ path: "activation", outcome: "no-current-owned-unexpired-row" });
      return;
    }
    if (
      Atomics.compareExchange(shared, state.status, state.starting, state.ready) === state.starting
    ) {
      port.postMessage(null, []);
    }
  }
  const receive = (
    request: LeaseHeartbeatParentMessage | { close: true } | HeartbeatRegistration,
  ) => {
    if (request !== null && "registration" in request) {
      return;
    }
    if (request !== null && "close" in request) {
      Atomics.store(shared, state.status, state.closed);
      Atomics.notify(shared, state.ack);
      close();
      return;
    }
    if (request !== null && "startup" in request) {
      if (params.deferActivation && Atomics.load(shared, state.status) === state.starting) {
        activateHeartbeat();
      }
      return;
    }
    if (Atomics.load(shared, state.status) !== state.ready) {
      return;
    }
    if (request !== null) {
      let reply: LeaseHeartbeatReply;
      let lost = false;
      let outcome: LeaseHeartbeatLoss["outcome"] = "operation-error";
      const path = request.operation === "renew" ? "explicit-renew" : "explicit-verify";
      try {
        const expiresAt =
          request.operation === "renew"
            ? renew(true, path)
            : withDatabaseAdmission(() =>
                observeDurableExpiry(readOpenClawStateLeaseExpiry(db, params.identity)),
              );
        if (expiresAt === undefined) {
          outcome = "no-current-owned-unexpired-row";
          throw new OpenClawStateLeaseError("state lease heartbeat no longer owns its lease", {
            code: "OPENCLAW_STATE_LEASE_LOST",
          });
        }
        reply = { id: request.id, ok: true, expiresAt };
      } catch (cause) {
        lost = !isSqliteLockError(cause);
        const error =
          cause instanceof OpenClawStateLeaseError
            ? cause
            : new OpenClawStateLeaseError(`failed to ${request.operation} state lease heartbeat`, {
                code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
                cause,
              });
        reply = {
          id: request.id,
          ok: false,
          message: error.message,
          payload: encodeOpenClawStateWorkerError(error),
        };
      }
      if (lost) {
        // Preserve the first loss before the existing request rejection can escape.
        recordLoss({ path, outcome });
      }
      // Parent deadlines can run before delivery of this completed request's reply.
      Atomics.store(completedRequest, 0, BigInt(request.id));
      port.postMessage(reply, []);
      if (lost) {
        lose({ path, outcome });
      }
      return;
    }
    // A caller may hold the state write transaction while checking ownership.
    // Liveness acknowledgements must never wait for that caller's SQLite lock.
    Atomics.store(shared, state.ack, Atomics.load(shared, state.request));
    Atomics.notify(shared, state.ack);
  };
  function runAutomatic(run: () => unknown, path: LeaseHeartbeatLoss["path"]): void {
    try {
      run();
    } catch {
      lose({ path, outcome: "operation-error" });
    }
  }
  function receiveMessage(
    request: LeaseHeartbeatParentMessage | { close: true } | HeartbeatRegistration,
  ): void {
    runAutomatic(() => receive(request), "automatic-renewal");
  }
  try {
    if (params.databaseEngineSelection) {
      installDatabaseEngineSelection(params.databaseEngineSelection);
    }
    const existingDatabase = databases.get(databaseKey);
    if (existingDatabase) {
      retainedDatabase = existingDatabase;
      retainedDatabase.references++;
    } else {
      // Only the first registration opens SQLite; later leases cannot stall active renewals.
      const opened = withDatabaseAdmission(openHeartbeatDatabase);
      retainedDatabase = {
        ...opened,
        renewals: createStateLeaseRenewalScheduler(opened.database),
        references: 1,
      };
      databases.set(databaseKey, retainedDatabase);
    }
    db = retainedDatabase.database;
    Atomics.store(shared, state.startupPhase, startupPhase["open-complete"]);
    port.on("message", receiveMessage);
    if (params.deferActivation) {
      port.postMessage({ startup: "prepared" } satisfies LeaseHeartbeatReply, []);
    } else {
      runAutomatic(activateHeartbeat, "activation");
    }
  } catch (error) {
    port.postMessage({ startupError: coerceErrorMessage(error) }, []);
    close();
  }
}

// SAFETY: The host owns this private carrier and transfers one typed port per lease.
if (!parentPort) {
  throw new Error("State lease heartbeat requires its parent port");
}
parentPort.on(
  "message",
  (message: LeaseHeartbeatParentMessage | { close: true } | HeartbeatRegistration) => {
    if (message !== null && "registration" in message) {
      startHeartbeat(message.registration, message.port);
    }
  },
);
// SAFETY: The host alone starts this private carrier with the typed initial lease payload.
startHeartbeat(workerData as LeaseHeartbeatWorkerData, parentPort, true);
