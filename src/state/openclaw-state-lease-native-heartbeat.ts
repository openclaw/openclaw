import { AsyncLocalStorage } from "node:async_hooks";
import { isSqliteLockError, sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  LEASE_CONTENTION_RETRY_MS,
  LEASE_CONTENTION_RETRY_TIMEOUT_MS,
} from "./openclaw-state-lease-heartbeat-shared.js";

const leaseLog = createSubsystemLogger("state/lease");

/** Schedules native renewals; the lease owner retains expiry and write authority. */
export function startOpenClawStateLeaseNativeHeartbeat(params: {
  heartbeatMs: number;
  renewalTimer: { dueAt?: number; lateByMs: number };
  signal: AbortSignal;
  expiresAt(): number;
  renew(): void;
  lose(error: unknown): void;
}) {
  let renewalRetry: ReturnType<typeof setTimeout> | undefined;
  let contentionFailures = 0;
  let unexpectedFailures = 0;
  let runRenewal: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined =
    AsyncLocalStorage.snapshot();
  const cancelRetry = () => {
    clearTimeout(renewalRetry);
    renewalRetry = undefined;
  };
  const tryRenewal = (retryUntil?: number) => {
    if (!heartbeat || !runRenewal || params.signal.aborted) {
      return;
    }
    try {
      runRenewal(() => params.renew());
    } catch (error) {
      if (
        (error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_LOST") ||
        Date.now() >= params.expiresAt()
      ) {
        params.lose(error);
        return;
      }
      if (!isSqliteLockError(error)) {
        if (unexpectedFailures++ === 0) {
          leaseLog.warn(
            `state lease native renewal failed (sqliteCode=${sqlitePrimaryResultCode(error) ?? "unknown"}; retrying on next heartbeat)`,
          );
        }
        return;
      }
      if (contentionFailures++ === 0) {
        leaseLog.warn("state lease native renewal delayed by SQLite contention");
      }
      const now = Date.now();
      const deadline = Math.min(
        retryUntil ?? now + LEASE_CONTENTION_RETRY_TIMEOUT_MS,
        params.expiresAt(),
      );
      if (now >= deadline) {
        return;
      }
      // Yield while SQLite's writer is busy, but never extend the owner's confirmed expiry.
      renewalRetry = setTimeout(
        () => {
          renewalRetry = undefined;
          if (Date.now() < deadline) {
            tryRenewal(deadline);
          }
        },
        Math.min(LEASE_CONTENTION_RETRY_MS, deadline - now),
      );
      renewalRetry.unref?.();
    }
  };
  params.renewalTimer.dueAt = Date.now() + params.heartbeatMs;
  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const now = Date.now();
    params.renewalTimer.lateByMs = Math.max(0, now - (params.renewalTimer.dueAt ?? now));
    params.renewalTimer.dueAt = now + params.heartbeatMs;
    if (!renewalRetry) {
      tryRenewal();
    }
  }, params.heartbeatMs);
  heartbeat.unref?.();
  const stop = () => {
    clearInterval(heartbeat);
    heartbeat = undefined;
    runRenewal = undefined;
    cancelRetry();
  };
  return {
    renewed() {
      if (!heartbeat) {
        return;
      }
      cancelRetry();
      // Manual renewal can enter offline publication; retain its verified authority.
      runRenewal = AsyncLocalStorage.snapshot();
    },
    stop,
    close() {
      stop();
      if (contentionFailures || unexpectedFailures) {
        leaseLog.warn(
          `state lease native renewal summary (contentionFailures=${contentionFailures}, unexpectedFailures=${unexpectedFailures})`,
        );
      }
    },
  };
}
