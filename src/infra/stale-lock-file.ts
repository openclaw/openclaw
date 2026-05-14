import fs from "node:fs/promises";
import { isPidDefinitelyDead as defaultIsPidDefinitelyDead } from "../shared/pid-alive.js";

export type LockFileSnapshot = {
  raw: string;
  payload: Record<string, unknown> | null;
};

export type LockFileOwnerPayload = {
  pid?: number;
  createdAt?: string;
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
  };
}

export async function readLockFileSnapshot(lockPath: string): Promise<LockFileSnapshot | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      raw,
      payload:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null,
    };
  } catch {
    return { raw, payload: null };
  }
}

export function shouldRemoveDeadOwnerOrExpiredLock(params: {
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
}): boolean {
  const payload = readLockFileOwnerPayload(params.payload);
  if (payload?.pid) {
    return (params.isPidDefinitelyDead ?? defaultIsPidDefinitelyDead)(payload.pid);
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    return !Number.isFinite(createdAt) || (params.nowMs ?? Date.now()) - createdAt > params.staleMs;
  }
  return false;
}

export async function removeLockFileIfSnapshotMatches(params: {
  lockPath: string;
  snapshot: LockFileSnapshot;
}): Promise<boolean> {
  const current = await readLockFileSnapshot(params.lockPath);
  if (!current) {
    return true;
  }
  if (current.raw !== params.snapshot.raw) {
    return false;
  }

  try {
    await fs.unlink(params.lockPath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function removeReportedStaleLockIfStillStale(params: {
  lockPath: string;
  shouldRemove: (snapshot: LockFileSnapshot) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const snapshot = await readLockFileSnapshot(params.lockPath);
  if (!snapshot) {
    return true;
  }
  if (!(await params.shouldRemove(snapshot))) {
    return false;
  }
  return await removeLockFileIfSnapshotMatches({
    lockPath: params.lockPath,
    snapshot,
  });
}
