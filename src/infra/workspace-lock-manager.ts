import fs from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TTL_MS = 30_000;

export type WorkspaceLockKind = "file" | "dir";

export type WorkspaceLockOptions = {
  kind?: WorkspaceLockKind;
  timeoutMs?: number;
  pollIntervalMs?: number;
  ttlMs?: number;
};

type LockPayload = {
  pid: number;
  createdAt: string;
  expiresAt: string;
  targetPath: string;
  kind: WorkspaceLockKind;
};

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
};

export type WorkspaceLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

const HELD_WORKSPACE_LOCKS_KEY = Symbol.for("openclaw.workspaceLockManager.heldLocks");
const HELD_WORKSPACE_LOCKS = resolveProcessScopedMap<HeldLock>(HELD_WORKSPACE_LOCKS_KEY);

function lockMapKey(kind: WorkspaceLockKind, normalizedTarget: string): string {
  return `${kind}:${normalizedTarget}`;
}

async function normalizeTargetPath(targetPath: string, kind: WorkspaceLockKind): Promise<string> {
  const resolved = path.resolve(targetPath);
  if (kind === "file") {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    return resolved;
  }
  await fs.mkdir(resolved, { recursive: true });
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function resolveLockPath(normalizedTarget: string, kind: WorkspaceLockKind): string {
  return kind === "file"
    ? `${normalizedTarget}.lock`
    : path.join(normalizedTarget, ".openclaw.workspace.lock");
}

function isTimestampExpired(isoTimestamp: string | undefined): boolean {
  if (!isoTimestamp) {
    return false;
  }
  const ts = Date.parse(isoTimestamp);
  return Number.isFinite(ts) && Date.now() >= ts;
}

async function readPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.targetPath !== "string" ||
      (parsed.kind !== "file" && parsed.kind !== "dir")
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      targetPath: parsed.targetPath,
      kind: parsed.kind,
    };
  } catch {
    return null;
  }
}

async function isStaleLock(lockPath: string, ttlMs: number): Promise<boolean> {
  const payload = await readPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) {
    return true;
  }
  if (payload && isTimestampExpired(payload.expiresAt)) {
    return true;
  }
  if (payload && !Number.isFinite(Date.parse(payload.createdAt))) {
    return true;
  }

  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > ttlMs;
  } catch {
    return true;
  }
}

async function releaseLock(mapKey: string): Promise<void> {
  const held = HELD_WORKSPACE_LOCKS.get(mapKey);
  if (!held) {
    return;
  }

  held.count -= 1;
  if (held.count > 0) {
    return;
  }

  HELD_WORKSPACE_LOCKS.delete(mapKey);
  await held.handle.close().catch(() => undefined);
  await fs.rm(held.lockPath, { force: true }).catch(() => undefined);
}

export async function acquireWorkspaceLock(
  targetPath: string,
  options: WorkspaceLockOptions = {},
): Promise<WorkspaceLockHandle> {
  const kind = options.kind ?? "file";
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);

  const normalizedTarget = await normalizeTargetPath(targetPath, kind);
  const lockPath = resolveLockPath(normalizedTarget, kind);
  const mapKey = lockMapKey(kind, normalizedTarget);

  const held = HELD_WORKSPACE_LOCKS.get(mapKey);
  if (held) {
    held.count += 1;
    return {
      lockPath,
      release: () => releaseLock(mapKey),
    };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const now = Date.now();
      const payload: LockPayload = {
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        targetPath: normalizedTarget,
        kind,
      };
      await handle.writeFile(JSON.stringify(payload), "utf8");
      HELD_WORKSPACE_LOCKS.set(mapKey, { count: 1, handle, lockPath });
      return {
        lockPath,
        release: () => releaseLock(mapKey),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }

      if (await isStaleLock(lockPath, ttlMs)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error(`workspace lock timeout for ${normalizedTarget}`);
}

export async function withWorkspaceLock<T>(
  targetPath: string,
  options: WorkspaceLockOptions = {},
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireWorkspaceLock(targetPath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
