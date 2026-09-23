import { parentPort, workerData } from "node:worker_threads";
import { coerceErrorMessage, toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runWithSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  isSqliteLockError,
  sqliteErrorCode,
  sqliteExtendedResultCode,
} from "../infra/sqlite-error-diagnostics.js";
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
  leaseHeartbeatStartupPhase as startupPhase,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatRenewalFailure,
  type LeaseHeartbeatReply,
  type LeaseHeartbeatParentMessage,
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
Atomics.store(shared, state.startupPhase, startupPhase["body-entry"]);
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
  const deadline = Date.now() + LEASE_HEARTBEAT_START_TIMEOUT_MS;
  const remaining = () =>
    Math.min(deadline, Number(Atomics.load(shared, state.expiresAt))) - Date.now();
  while (remaining() > 0 && Atomics.load(shared, state.status) === state.starting) {
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
    Atomics.wait(shared, state.status, state.starting, Math.max(1, Math.min(25, remaining())));
  }
  throw new Error("state lease heartbeat startup deadline expired or owner stopped");
}
const db = openHeartbeatDatabase();
Atomics.store(shared, state.startupPhase, startupPhase["open-complete"]);
let processOwner = params.processOwner;
let heartbeat: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
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
  attempt += 1;
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
    if (expiresAt !== undefined) {
      Atomics.store(shared, state.lastRenewedAt, BigInt(expiresAt - params.leaseMs));
    }
    if (expiresAt !== undefined && processOwner?.identity.startedAt != null) {
      processOwner = undefined;
    }
  } catch (error) {
    if (!(error instanceof StateDatabaseCoordinatorContentionError) && !isSqliteLockError(error)) {
      parentPort?.postMessage(
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
    () => {
      if (params.deferActivation && Atomics.load(shared, state.status) === state.starting) {
        activateHeartbeat();
      } else {
        renew();
      }
    },
    Math.max(1, Math.min(params.heartbeatMs, expiresAt - Date.now())),
  );
  // A still-valid old expiry permits automatic retry, not renewal success.
  if (explicit && contentionError !== undefined) {
    throw toErrorObject(contentionError, "state lease heartbeat renewal was delayed");
  }
  return expiresAt;
};

function activateHeartbeat(): void {
  let expiresAt: number | undefined;
  try {
    Atomics.store(shared, state.startupPhase, startupPhase["initial-renew-start"]);
    expiresAt = renew(params.deferActivation === true);
    Atomics.store(shared, state.startupPhase, startupPhase["initial-renew-returned"]);
  } catch (error) {
    if (
      params.deferActivation &&
      (error instanceof StateDatabaseCoordinatorContentionError || isSqliteLockError(error))
    ) {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(
        activateHeartbeat,
        Math.max(
          1,
          Math.min(params.heartbeatMs, Number(Atomics.load(shared, state.expiresAt)) - Date.now()),
        ),
      );
      return;
    }
    lose();
    throw error;
  }
  if (expiresAt === undefined) {
    lose();
    return;
  }
  if (
    Atomics.compareExchange(shared, state.status, state.starting, state.ready) === state.starting
  ) {
    parentPort?.postMessage(null, []);
  }
}
parentPort?.on("message", (request: LeaseHeartbeatParentMessage) => {
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
if (params.deferActivation) {
  parentPort?.postMessage({ startup: "prepared" } satisfies LeaseHeartbeatReply, []);
} else {
  activateHeartbeat();
}
