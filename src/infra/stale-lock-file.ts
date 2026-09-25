// Determines whether persisted lock-file owners are stale.
import {
  getFileLockProcessStartTime as defaultGetProcessStartTime,
  isPidDefinitelyDead as defaultIsPidDefinitelyDead,
} from "../shared/pid-alive.js";

type LockFileOwnerPayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
};

function readLockFileOwnerPayload(
  payload: Record<string, unknown> | null,
): LockFileOwnerPayload | null {
  if (!payload) {
    return null;
  }
  return {
    pid:
      typeof payload.pid === "number" && Number.isInteger(payload.pid) && payload.pid > 0
        ? payload.pid
        : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    starttime:
      typeof payload.starttime === "number" &&
      Number.isInteger(payload.starttime) &&
      payload.starttime >= 0
        ? payload.starttime
        : undefined,
  };
}

type LockOwnerInspection = {
  payload: Record<string, unknown> | null;
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
};

type StaleLockOwner = {
  reason: "owner-starttime-changed" | "owner-process-exited";
  pid: number;
  recordedStarttime: number | null;
  observedStarttime: number | null;
};

/** Capture only the bounded facts used by this exact stale decision. Never
 * resample the owner after failure or copy arbitrary sidecar payload fields. */
export function inspectStaleLockOwner(params: LockOwnerInspection): StaleLockOwner | null {
  const payload = readLockFileOwnerPayload(params.payload);
  if (!payload?.pid) {
    // An incomplete sidecar can belong to a suspended live writer.
    return null;
  }
  const observedStarttime =
    payload.starttime === undefined
      ? null
      : (params.getProcessStartTime ?? defaultGetProcessStartTime)(payload.pid);
  const identity = {
    pid: payload.pid,
    recordedStarttime: payload.starttime ?? null,
    observedStarttime,
  };
  // Timestamp age cannot prove the owner stopped writing. Only a mismatched
  // process start time proves PID reuse while the PID is alive.
  const normalizedStored =
    process.platform === "darwin" &&
    payload.starttime !== undefined &&
    payload.starttime > 10_000_000_000
      ? Math.floor(payload.starttime / 1_000_000)
      : payload.starttime;
  if (observedStarttime !== null && observedStarttime !== normalizedStored) {
    return { reason: "owner-starttime-changed", ...identity };
  }
  return (params.isPidDefinitelyDead ?? defaultIsPidDefinitelyDead)(payload.pid)
    ? { reason: "owner-process-exited", ...identity }
    : null;
}

export function isLockOwnerDefinitelyStale(params: LockOwnerInspection): boolean {
  return inspectStaleLockOwner(params) !== null;
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
    return isLockOwnerDefinitelyStale({
      payload: params.payload,
      isPidDefinitelyDead: params.isPidDefinitelyDead,
      getProcessStartTime: params.getProcessStartTime,
    });
  }
  if (!payload?.createdAt) {
    return false;
  }
  const createdAt = Date.parse(payload.createdAt);
  return !Number.isFinite(createdAt) || (params.nowMs ?? Date.now()) - createdAt > params.staleMs;
}
