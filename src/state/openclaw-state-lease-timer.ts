import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import { formatLeaseRenewalError } from "./openclaw-state-lease-error.js";
import {
  leaseHeartbeatState as state,
  LEASE_CONTENTION_RETRY_MS,
} from "./openclaw-state-lease-heartbeat-shared.js";

const leaseLog = createSubsystemLogger("state/lease");

/** Parent-scheduled renewal; the lease owner retains each actor operation and its settlement. */
export function startOpenClawStateLeaseTimer(params: {
  identity: { scope: string; key: string };
  observation: BigInt64Array<SharedArrayBuffer>;
  leaseMs: number;
  heartbeatMs: number;
  renew(): Promise<unknown>;
  recover(): Promise<unknown>;
  onRenewError(error: unknown): void;
  onLost(error: Error): void;
}) {
  let stopped = false;
  let expiryClosed = false;
  let recovering = false;
  let renewal: Promise<unknown> | undefined;
  let cancelExpiry: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const clearTimers = () => {
    clearInterval(heartbeat);
    clearTimeout(retry);
    retry = undefined;
    heartbeat = undefined;
  };
  let attempts = 0;
  let failures = 0;
  let attemptStartedAt = 0;
  let attemptExpiry = 0;
  let lastFailure: string | undefined;
  const label = `scope=${JSON.stringify(params.identity.scope)}, key=${JSON.stringify(params.identity.key)}`;
  const renew = (recoverExpired = false): Promise<unknown> | undefined => {
    if (stopped || renewal || (recovering && !recoverExpired)) {
      return renewal;
    }
    if (
      !recoverExpired &&
      Number(Atomics.load(params.observation, state.expiresAt)) <= Date.now()
    ) {
      checkExpiry();
      return renewal;
    }
    clearTimeout(retry);
    retry = undefined;
    attempts++;
    attemptStartedAt = Date.now();
    attemptExpiry = Number(Atomics.load(params.observation, state.expiresAt));
    lastFailure = undefined;
    const pending = (async () => (recoverExpired ? params.recover() : params.renew()))();
    renewal = pending;
    void pending.then(
      () => {
        renewal = undefined;
      },
      (error: unknown) => {
        renewal = undefined;
        if (recoverExpired) {
          // The expiry observer reports this single failed recovery with its original diagnostics.
          return;
        }
        lastFailure = formatLeaseRenewalError(error);
        if (extractErrorCode(error) !== "OPENCLAW_STATE_LEASE_LOST") {
          failures++;
          if (failures === 1) {
            leaseLog.warn(
              `state lease renewal failed (${label}, attempt=${attempts}, ${lastFailure})`,
            );
          }
        }
        params.onRenewError(error);
        if (!stopped && !recovering && isSqliteLockError(error)) {
          // Waiting for the next normal tick can leave no retry before durable expiry.
          retry = setTimeout(() => void renew(), LEASE_CONTENTION_RETRY_MS);
          retry.unref?.();
        }
      },
    );
    return pending;
  };
  heartbeat = setInterval(() => void renew(), params.heartbeatMs);
  heartbeat.unref?.();
  const checkExpiry = () => {
    cancelExpiry?.();
    cancelExpiry = undefined;
    if (expiryClosed || recovering) {
      return;
    }
    // Commit publication can precede the actor reply in the parent's event queue.
    const expiresAt = Number(Atomics.load(params.observation, state.expiresAt));
    if (expiresAt <= Date.now()) {
      // Durable publication can outlive its reply or supersede an earlier failure.
      const detail = renewal
        ? `renewal pending, attempt=${attempts}, pendingSince=${new Date(attemptStartedAt).toISOString()}, pendingMs=${Date.now() - attemptStartedAt}`
        : lastFailure && attemptExpiry === expiresAt
          ? `last renewal failed, attempt=${attempts}, ${lastFailure}`
          : `no renewal attempted since last commit, lastSuccessAgeMs=${Date.now() - (expiresAt - params.leaseMs)}`;
      const message = `state lease expired (${label}, ${detail}, renewalFailures=${failures})`;
      const overdueMs = Date.now() - expiresAt;
      recovering = true;
      // Join an existing renewal; never race a second write against its publication.
      void Promise.allSettled([renewal ?? renew(true)]).then(([outcome]) => {
        recovering = false;
        if (expiryClosed) {
          return;
        }
        if (
          outcome?.status === "fulfilled" &&
          Number(Atomics.load(params.observation, state.expiresAt)) > Date.now()
        ) {
          leaseLog.warn(
            `state lease recovered after missed renewals (${label}, overdueMs=${overdueMs}, attempts=${attempts})`,
          );
          checkExpiry();
          return;
        }
        stopped = true;
        expiryClosed = true;
        clearTimers();
        leaseLog.warn(message);
        params.onLost(new Error(message));
      });
      return;
    }
    cancelExpiry = scheduleAbsoluteDeadline(expiresAt, checkExpiry, undefined, { unref: true });
  };
  try {
    checkExpiry();
  } catch (error) {
    clearTimers();
    cancelExpiry?.();
    throw error;
  }
  const stopRenewal = async () => {
    stopped = true;
    clearTimers();
    if (renewal) {
      // The lease owner handles the error; stopping must still join native settlement.
      await Promise.allSettled([renewal]);
    }
  };
  return {
    isExpired: () => Number(Atomics.load(params.observation, state.expiresAt)) <= Date.now(),
    stopRenewal,
    async close() {
      await stopRenewal();
      if (!expiryClosed && failures > 0) {
        leaseLog.warn(
          `state lease released (${label}, attempts=${attempts}, renewalFailures=${failures})`,
        );
      }
      expiryClosed = true;
      cancelExpiry?.();
      cancelExpiry = undefined;
    },
  };
}
