import { parentPort, workerData } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runWithSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  acquireStateDatabaseCoordinator,
  StateDatabaseCoordinatorContentionError,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  leaseHeartbeatState as state,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatReply,
  type LeaseHeartbeatRequest,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  readOpenClawStateLeaseExpiry,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

// SAFETY: The lease owner alone starts this private entry with its typed structured-clone payload.
const params = workerData as LeaseHeartbeatWorkerData;
const shared = new BigInt64Array(params.shared);
function observeDurableExpiry(expiresAt: number | undefined) {
  Atomics.store(shared, state.expiresAt, BigInt(expiresAt ?? 0));
  return expiresAt;
}
function withLifecycleCoordinator<T>(label: string, operation: () => T): T {
  // This private worker participates in an actual parent-owned coordinator,
  // retained before construction and released only after native worker exit.
  // Its persisted lease identity and expiry are still checked for every renewal.
  const run = () =>
    params.parentCoordinatorRetained
      ? operation()
      : runWithSqliteCoordinator(
          acquireStateDatabaseCoordinator({ databasePath: params.path, busyTimeoutMs: 0 }),
          label,
          operation,
        );
  return params.retainedStartup
    ? withStateDatabaseCoordinatorRuntimeDirectory(params.retainedStartup.coordinatorRuntime, run)
    : run();
}
function openHeartbeatDatabase() {
  // The parent's bound is a retry deadline, not ownership. Renewal below still
  // checks the exact current persisted owner/expiry before changing the row.
  const deadline = Math.min(params.expiresAt, Date.now() + LEASE_HEARTBEAT_START_TIMEOUT_MS);
  while (Date.now() < deadline && Atomics.load(shared, state.status) === state.starting) {
    try {
      return withLifecycleCoordinator("maintenance heartbeat open", () =>
        openTrackedStateDatabase(params.path, {
          existingOnly: params.retainedStartup ? true : params.existingOnly,
          expectedIdentity: params.retainedStartup?.expectedIdentity,
        }),
      );
    } catch (error) {
      if (!(error instanceof StateDatabaseCoordinatorContentionError)) {
        throw error;
      }
    }
    Atomics.wait(
      shared,
      state.status,
      state.starting,
      Math.max(1, Math.min(25, deadline - Date.now())),
    );
  }
  throw new Error("state lease heartbeat startup deadline expired or owner stopped");
}
const db = openHeartbeatDatabase();
let processOwner = params.processOwner;
let heartbeat: ReturnType<typeof setTimeout> | undefined;
const lose = () => {
  Atomics.compareExchange(shared, state.status, state.starting, state.lost);
  Atomics.compareExchange(shared, state.status, state.ready, state.lost);
  Atomics.notify(shared, state.ack);
  clearTimeout(heartbeat);
  closeTrackedStateDatabase(db);
  parentPort?.close();
};
const renew = (explicit = false): number | undefined => {
  if (Atomics.load(shared, state.status) >= state.closed) {
    return undefined;
  }
  let expiresAt: number | undefined;
  let contentionError: unknown;
  try {
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
    expiresAt = withLifecycleCoordinator("maintenance heartbeat renewal", () =>
      runWithSqliteBusyTimeout(
        db,
        0,
        () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
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
            { logger: { warn() {} } },
          ),
        { lockFailureReporting: "suppress" },
      ),
    );
    if (expiresAt !== undefined && processOwner?.identity.startedAt != null) {
      processOwner = undefined;
    }
  } catch (error) {
    if (!(error instanceof StateDatabaseCoordinatorContentionError) && !isSqliteLockError(error)) {
      if (explicit) {
        throw error;
      }
      lose();
      return undefined;
    }
    contentionError = error;
    expiresAt = readOpenClawStateLeaseExpiry(db, params.identity);
  }
  observeDurableExpiry(expiresAt);
  if (expiresAt === undefined) {
    if (!explicit) {
      lose();
    }
    return undefined;
  }
  // Contention may delay renewal, but must never delay expiry detection by a
  // full heartbeat interval or authorize renewal after the persisted deadline.
  clearTimeout(heartbeat);
  heartbeat = setTimeout(
    () => renew(),
    Math.max(1, Math.min(params.heartbeatMs, expiresAt - Date.now())),
  );
  // A still-valid old expiry permits automatic retry, not renewal success.
  if (explicit && contentionError !== undefined) {
    throw toErrorObject(contentionError, "state lease heartbeat renewal was delayed");
  }
  return expiresAt;
};

renew();
if (Atomics.compareExchange(shared, state.status, state.starting, state.ready) === state.starting) {
  parentPort?.on("message", (request: LeaseHeartbeatRequest | null) => {
    if (Atomics.load(shared, state.status) !== state.ready) {
      return;
    }
    if (request !== null) {
      let reply: LeaseHeartbeatReply;
      let lost = false;
      try {
        const expiresAt =
          request.operation === "renew"
            ? renew(true)
            : observeDurableExpiry(readOpenClawStateLeaseExpiry(db, params.identity));
        if (expiresAt === undefined) {
          throw new OpenClawStateLeaseError("state lease heartbeat no longer owns its lease", {
            code: "OPENCLAW_STATE_LEASE_LOST",
          });
        }
        reply = { id: request.id, ok: true, expiresAt };
      } catch (cause) {
        lost =
          !(cause instanceof StateDatabaseCoordinatorContentionError) && !isSqliteLockError(cause);
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
      parentPort?.postMessage(reply, []);
      if (lost) {
        lose();
      }
      return;
    }
    // A caller may hold the state write transaction while checking ownership.
    // Liveness acknowledgements must never wait for that caller's SQLite lock.
    Atomics.store(shared, state.ack, Atomics.load(shared, state.request));
    Atomics.notify(shared, state.ack);
  });
  parentPort?.postMessage(null, []);
}
