import {
  getProcessStartTime as defaultGetProcessStartTime,
  isPidDefinitelyDead as defaultIsPidDefinitelyDead,
} from "../shared/pid-alive.js";

export type LockFileOwnerPayload = {
  pid?: number;
  createdAt?: string;
  startTime?: number;
};

export function readLockFileOwnerPayload(
  payload: Record<string, unknown> | null,
): LockFileOwnerPayload | null {
  if (!payload) {
    return null;
  }
  return {
    pid: typeof payload.pid === "number" ? payload.pid : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    startTime: typeof payload.startTime === "number" ? payload.startTime : undefined,
  };
}

function isLockExpired(
  createdAt: string | undefined,
  staleMs: number,
  nowMs: number | undefined,
): boolean {
  if (!createdAt) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  return !Number.isFinite(createdAtMs) || (nowMs ?? Date.now()) - createdAtMs > staleMs;
}

export function shouldRemoveDeadOwnerOrExpiredLock(params: {
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
}): boolean {
  const payload = readLockFileOwnerPayload(params.payload);
  if (payload?.pid) {
    const isPidDefinitelyDead = params.isPidDefinitelyDead ?? defaultIsPidDefinitelyDead;
    if (isPidDefinitelyDead(payload.pid)) {
      return true;
    }
    // The owner PID is alive, but a live PID alone does not prove the original
    // lock owner is still running. Container inits reuse low PIDs across
    // restarts — an exec-style entrypoint makes the app PID 2 on every boot —
    // so a lock written by a previous process records a PID that a new,
    // unrelated process now holds, and a pure liveness check keeps the lock
    // forever (the OlmMachine never re-initializes; the bot syncs but cannot
    // decrypt). When the owner's process start time was recorded, a mismatch
    // proves the PID was recycled, so the lock is stale and reclaimable.
    // Without a recorded start time (locks written before this field existed),
    // preserve the original behavior of never stealing a live PID's lock.
    if (payload.startTime != null) {
      const getProcessStartTime = params.getProcessStartTime ?? defaultGetProcessStartTime;
      const currentStartTime = getProcessStartTime(payload.pid);
      return currentStartTime != null && currentStartTime !== payload.startTime;
    }
    return false;
  }
  return isLockExpired(payload?.createdAt, params.staleMs, params.nowMs);
}
