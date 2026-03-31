import { createHash } from "node:crypto";
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
  signal?: AbortSignal;
};

type LockPayload = {
  token: string;
  pid: number;
  createdAt: string;
  expiresAt: string;
  targetPath: string;
  kind: WorkspaceLockKind;
};

type HeldLock = {
  lockPath: string;
  token: string;
  ttlMs: number;
};

const CROSS_USER_LOCK_DIR_MODE = 0o777;

async function shouldNormalizeUnresolvedPathCase(targetPath: string): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  if (process.platform !== "darwin") {
    return false;
  }

  let cursor = path.resolve(targetPath);
  while (true) {
    try {
      return await probeDirectoryCaseInsensitive(cursor);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return false;
      }
      cursor = parent;
    }
  }
}

async function probeDirectoryCaseInsensitive(existingPath: string): Promise<boolean> {
  const parent = path.dirname(existingPath);
  const probeName = `.openclaw-case-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probePath = path.join(parent, probeName);
  const altPath = path.join(parent, probeName.toUpperCase());
  await fs.writeFile(probePath, "", { flag: "wx" });
  try {
    await fs.stat(altPath);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
}

function normalizeLockPathCase(value: string, normalizeCase: boolean): string {
  return normalizeCase ? value.toLowerCase() : value;
}

export type WorkspaceLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
};

const HELD_WORKSPACE_LOCKS_KEY = Symbol.for("openclaw.workspaceLockManager.heldLocks");
const HELD_WORKSPACE_LOCKS = resolveProcessScopedMap<HeldLock>(HELD_WORKSPACE_LOCKS_KEY);

function lockMapKey(kind: WorkspaceLockKind, normalizedTarget: string): string {
  return `${kind}:${normalizedTarget}`;
}

async function canonicalizePathViaNearestExistingAncestor(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let cursor = resolved;
  const normalizeCase = await shouldNormalizeUnresolvedPathCase(resolved);

  // Walk upward until we hit an existing ancestor (or filesystem root).
  while (true) {
    try {
      const canonical = await fs.realpath(cursor);
      return suffix.length === 0 ? canonical : path.join(canonical, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return suffix.length === 0 ? resolved : path.join(cursor, ...suffix.toReversed());
      }
      // Preserve unresolved suffix casing so lock identity remains stable before and
      // after path materialization for the same logical target string.
      suffix.push(normalizeLockPathCase(path.basename(cursor), normalizeCase));
      cursor = parent;
    }
  }
}

async function normalizeTargetPath(targetPath: string, kind: WorkspaceLockKind): Promise<string> {
  const resolved = path.resolve(targetPath);
  if (kind === "file") {
    return await canonicalizePathViaNearestExistingAncestor(resolved);
  }
  await fs.mkdir(resolved, { recursive: true });
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function resolveLockPath(normalizedTarget: string, kind: WorkspaceLockKind): Promise<string> {
  // Use a shared cross-user namespace so different OS users locking the same
  // target converge on the same lock file. For "dir" targets the lock lives
  // inside the directory itself. For "file" targets we derive the lock dir
  // from the file's parent directory so any user with write access to the
  // workspace sees the same lock.
  const lockBaseDir = kind === "dir" ? normalizedTarget : path.dirname(normalizedTarget);
  const lockDir = path.join(lockBaseDir, ".openclaw.workspace-locks");
  const digest = createHash("sha256")
    .update(`${kind}:${normalizedTarget}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(lockDir, `${kind}-${digest}.lock`);
}

async function ensureCrossUserWritableLockDir(lockPath: string): Promise<void> {
  const lockDir = path.dirname(lockPath);
  await fs.mkdir(lockDir, { recursive: true, mode: CROSS_USER_LOCK_DIR_MODE });
  if (process.platform !== "win32") {
    await fs.chmod(lockDir, CROSS_USER_LOCK_DIR_MODE).catch(() => undefined);
  }
}

// resolveLockOwnerScope removed — lock paths are now derived from the target
// path's parent directory to ensure cross-user convergence.

function createAbortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

function isTimestampExpired(isoTimestamp: string | undefined): boolean {
  if (!isoTimestamp) {
    return false;
  }
  const ts = Date.parse(isoTimestamp);
  return Number.isFinite(ts) && Date.now() >= ts;
}

function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.targetPath !== "string" ||
      (parsed.kind !== "file" && parsed.kind !== "dir")
    ) {
      return null;
    }
    return {
      token: parsed.token,
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

async function readPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return parseLockPayload(raw);
  } catch {
    return null;
  }
}

async function readPayloadFromHandle(handle: fs.FileHandle): Promise<LockPayload | null> {
  try {
    // Always read from position 0 so callers don't silently read empty
    // strings after prior reads/writes have advanced the file offset.
    const stat = await handle.stat();
    const buf = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const raw = buf.toString("utf8", 0, bytesRead);
    return parseLockPayload(raw);
  } catch {
    return null;
  }
}

async function isStalePayload(payload: LockPayload): Promise<boolean> {
  if (!Number.isFinite(Date.parse(payload.createdAt))) {
    return true;
  }
  if (isTimestampExpired(payload.expiresAt)) {
    return true;
  }
  if (payload.pid && !isPidAlive(payload.pid)) {
    return true;
  }
  return false;
}

async function isStaleLock(lockPath: string, ttlMs: number): Promise<boolean> {
  const payload = await readPayload(lockPath);
  if (payload) {
    return await isStalePayload(payload);
  }

  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > ttlMs;
  } catch {
    return true;
  }
}

async function tryRemoveStaleLock(lockPath: string, ttlMs: number): Promise<boolean> {
  const firstPayload = await readPayload(lockPath);
  if (firstPayload) {
    if (!(await isStalePayload(firstPayload))) {
      return false;
    }

    const snapshot = JSON.stringify(firstPayload);
    const secondPayload = await readPayload(lockPath);
    if (!secondPayload) {
      return false;
    }
    if (JSON.stringify(secondPayload) !== snapshot) {
      return false;
    }
    if (!(await isStalePayload(secondPayload))) {
      return false;
    }

    // Atomic ownership revalidation at unlink time: open the lock file, re-read
    // its payload to confirm it still matches the stale snapshot, verify the
    // inode hasn't changed (i.e. another process hasn't replaced it), then
    // unlink. This closes the TOCTOU window where a concurrent refresh/replace
    // could occur between our second read and the rm.
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "r");
      const handlePayload = await readPayloadFromHandle(handle);
      if (!handlePayload || JSON.stringify(handlePayload) !== snapshot) {
        // Lock payload changed since our validation — another process refreshed it.
        return false;
      }
      if (!(await isStalePayload(handlePayload))) {
        return false;
      }
      // Verify the on-disk inode still matches our open handle so we don't
      // unlink a replacement file.
      const [openedStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(lockPath)]);
      if (openedStat.ino !== pathStat.ino || openedStat.dev !== pathStat.dev) {
        return false;
      }
      await handle.close().catch(() => undefined);
      handle = undefined;
      return await fs
        .rm(lockPath, { force: true })
        .then(() => true)
        .catch(() => false);
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  if (!(await isStaleLock(lockPath, ttlMs))) {
    return false;
  }
  // For payloadless stale locks, also use inode-based validation.
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockPath, "r");
    const [openedStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(lockPath)]);
    if (openedStat.ino !== pathStat.ino || openedStat.dev !== pathStat.dev) {
      return false;
    }
    // Re-check staleness with the handle's mtime to avoid removing a lock that
    // was refreshed between the initial check and our open.
    if (Date.now() - openedStat.mtimeMs <= ttlMs) {
      return false;
    }
    await handle.close().catch(() => undefined);
    handle = undefined;
    return await fs
      .rm(lockPath, { force: true })
      .then(() => true)
      .catch(() => false);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function refreshLock(mapKey: string, token: string): Promise<void> {
  const held = HELD_WORKSPACE_LOCKS.get(mapKey);
  if (!held || held.token !== token) {
    return;
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(held.lockPath, "r+");
    const previousStat = await handle.stat();
    const previousBuffer = Buffer.alloc(previousStat.size);
    const { bytesRead: previousBytesRead } = await handle.read(
      previousBuffer,
      0,
      previousBuffer.length,
      0,
    );
    const previousRaw = previousBuffer.toString("utf8", 0, previousBytesRead);
    const payload = await readPayloadFromHandle(handle);
    if (!payload || payload.token !== held.token || payload.token !== token) {
      return;
    }

    const now = Date.now();
    const nextPayload: LockPayload = {
      ...payload,
      expiresAt: new Date(now + held.ttlMs).toISOString(),
    };

    const serialized = JSON.stringify(nextPayload);
    const buf = Buffer.from(serialized, "utf8");

    // Retry up to 3 times on short writes to avoid leaving corrupted JSON on disk.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { bytesWritten } = await handle.write(buf, 0, buf.length, 0);
      if (bytesWritten === buf.length) {
        await handle.truncate(bytesWritten);
        // Verify the written payload is parseable.
        const verification = await readPayloadFromHandle(handle);
        if (verification && verification.token === token) {
          break;
        }
      }
      if (attempt === 2) {
        await handle.write(Buffer.from(previousRaw, "utf8"), 0, Buffer.byteLength(previousRaw), 0);
        await handle.truncate(Buffer.byteLength(previousRaw));
        throw new Error(
          `refreshLock: failed to write full payload after 3 attempts; aborting to preserve lock integrity`,
        );
      }
    }
  } catch {
    // Preserve exclusivity on transient write errors; do not delete lock here.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function releaseLock(mapKey: string, token: string): Promise<void> {
  const held = HELD_WORKSPACE_LOCKS.get(mapKey);
  if (!held || held.token !== token) {
    return;
  }

  HELD_WORKSPACE_LOCKS.delete(mapKey);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(held.lockPath, "r");
    const payload = await readPayloadFromHandle(handle);
    if (!payload || payload.token !== held.token || payload.token !== token) {
      return;
    }

    // Re-check the path identity after opening to reduce release-vs-reclaim races.
    const [openedStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(held.lockPath)]);
    if (openedStat.ino !== pathStat.ino || openedStat.dev !== pathStat.dev) {
      return;
    }

    // Close handle BEFORE unlinking — Windows rejects rm on open files (EPERM).
    await handle.close().catch(() => undefined);
    handle = undefined;
    await fs.rm(held.lockPath, { force: true }).catch(() => undefined);
  } catch {
    // Best-effort cleanup only.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function acquireWorkspaceLock(
  targetPath: string,
  options: WorkspaceLockOptions = {},
): Promise<WorkspaceLockHandle> {
  const kind = options.kind ?? "file";
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  // Minimum 200ms keeps TTL above the refresh floor so locks cannot expire
  // before the first withWorkspaceLock refresh fires (see refreshEveryMs).
  const ttlMs = Math.max(200, options.ttlMs ?? DEFAULT_TTL_MS);
  const signal = options.signal;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const normalizedTarget = await normalizeTargetPath(targetPath, kind);
  const lockPath = await resolveLockPath(normalizedTarget, kind);
  // Create intermediate directories for the lock file. For "file" targets we
  // need both the target's parent chain AND the .openclaw.workspace-locks leaf.
  // Use recursive:true so missing ancestors are created when the write tool
  // locks a file that doesn't exist yet.
  await ensureCrossUserWritableLockDir(lockPath);
  const mapKey = lockMapKey(kind, normalizedTarget);

  // Do not allow implicit same-process reentrancy here. Callers must serialize
  // before acquisition (e.g. via per-target queues) so critical sections remain exclusive.

  const startedAt = Date.now();
  const sleep = async (ms: number): Promise<void> => {
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  while (Date.now() - startedAt <= timeoutMs) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    try {
      const handle = await fs.open(lockPath, "wx");
      const now = Date.now();
      const payload: LockPayload = {
        token: `${process.pid}-${now}-${Math.random().toString(16).slice(2)}`,
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        targetPath: normalizedTarget,
        kind,
      };

      try {
        await handle.writeFile(JSON.stringify(payload), "utf8");
      } catch (writeErr) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw writeErr;
      }

      await handle.close();
      HELD_WORKSPACE_LOCKS.set(mapKey, { lockPath, token: payload.token, ttlMs });
      return {
        lockPath,
        release: () => releaseLock(mapKey, payload.token),
        refresh: () => refreshLock(mapKey, payload.token),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }

      if (await tryRemoveStaleLock(lockPath, ttlMs)) {
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await sleep(pollIntervalMs);
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
  // Enforce a minimum TTL of 200ms so the refresh interval (ttl/2) is always
  // >= 100ms and the lock cannot expire before the first refresh fires.
  const ttlMs = Math.max(200, options.ttlMs ?? DEFAULT_TTL_MS);
  const refreshEveryMs = Math.max(100, Math.floor(ttlMs / 2));
  const timer = setInterval(() => {
    void lock.refresh().catch(() => undefined);
  }, refreshEveryMs);
  timer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await lock.release();
  }
}
