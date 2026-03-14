import { randomBytes } from "crypto";
import fs from "fs/promises";
import path from "path";

export type TokenUsageRecord = {
  id: string;
  label: string;
  tokensUsed: number;
  tokenLimit?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  provider?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  createdAt: string;
};

function makeId() {
  return `usage_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

async function readJsonArray(file: string): Promise<TokenUsageRecord[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Valid JSON but unexpected shape (object, number, string, …).
      // Returning [] here would cause appendRecord to overwrite the file
      // with only the new entry, silently deleting prior data.
      throw Object.assign(
        new Error(
          `token-usage.json contains valid JSON but is not an array (got ${typeof parsed})`,
        ),
        { code: "ERR_UNEXPECTED_TOKEN_LOG_SHAPE" },
      );
    }
    return parsed as TokenUsageRecord[];
  } catch (err) {
    // File does not exist yet — start with an empty array.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // Any other error (malformed JSON, permission denied, partial write, …)
    // must propagate so appendRecord aborts and the existing file is not
    // silently overwritten with only the new entry.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-process file lock
//
// The in-memory writeQueues Map serialises writes within a single Node
// process, but two concurrent OpenClaw processes targeting the same
// workspaceDir can still race: both read the same snapshot before either
// writes.  We guard against that with an advisory lock file (.lock) using
// O_EXCL (create-exclusive), which is atomic on POSIX filesystems.
//
// The lock file stores the holder's PID so that waiters can detect a stale
// lock left by a crashed process.  On each EEXIST the waiter reads the PID
// and calls kill(pid, 0): if the process no longer exists (ESRCH) the lock
// is stale and is reclaimed immediately via a fresh O_EXCL open, preserving
// mutual exclusion even when multiple waiters race for the steal.  If the
// holder is alive the waiter backs off for LOCK_RETRY_MS and retries.
// After LOCK_TIMEOUT_MS without acquiring the lock ERR_LOCK_TIMEOUT is
// thrown; the lock file is left untouched to avoid breaking a live holder.
// ---------------------------------------------------------------------------
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Returns true only when the lock at `lockPath` was written by a process
 * that no longer exists (ESRCH).  Any other outcome (process alive, EPERM,
 * unreadable file, non-numeric content) is treated as "not stale" so we
 * never break a legitimately held lock.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const pid = parseInt(raw.trim(), 10);
    if (isNaN(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0); // signal 0 checks existence without delivering a signal
      return false; // process is alive
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false; // can't read lock — treat as live
  }
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const myPid = String(process.pid);

  while (Date.now() < deadline) {
    let fh: fs.FileHandle | undefined;
    try {
      // wx = O_WRONLY | O_CREAT | O_EXCL — fails if the file already exists.
      // Write our PID so that a waiting process can verify we are still alive.
      fh = await fs.open(lockPath, "wx");
      await fh.writeFile(myPid);
      await fh.close();
      fh = undefined;
      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      await fh?.close().catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      // The lock file exists.  Check immediately whether the holder crashed;
      // if so, unlink the stale lock and loop back to race on O_EXCL.
      // Multiple concurrent waiters may all detect the stale lock and attempt
      // the unlink — that is fine because only one O_EXCL open will succeed.
      if (await isLockStale(lockPath)) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }
      // Holder is alive — back off and retry.
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  // Timed out without acquiring the lock. The lock file is intentionally left
  // untouched: the holder may still be active (slow disk, large file), and
  // removing a live lock would break mutual exclusion.
  throw Object.assign(new Error(`Could not acquire lock ${lockPath} within ${LOCK_TIMEOUT_MS}ms`), {
    code: "ERR_LOCK_TIMEOUT",
  });
}

async function appendRecord(file: string, entry: TokenUsageRecord): Promise<void> {
  const lockPath = `${file}.lock`;
  await withFileLock(lockPath, async () => {
    const records = await readJsonArray(file);
    records.push(entry);
    await fs.writeFile(file, JSON.stringify(records, null, 2));
  });
}

// Per-file write queue: serialises concurrent recordTokenUsage() calls within
// the same process so they do not all contend on the cross-process file lock.
const writeQueues = new Map<string, Promise<void>>();

export async function recordTokenUsage(params: {
  workspaceDir: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  label: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}) {
  const usage = params.usage;
  if (!usage) {
    return;
  }
  const total =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (!total || total <= 0) {
    return;
  }

  const memoryDir = path.join(params.workspaceDir, "memory");
  const file = path.join(memoryDir, "token-usage.json");
  await fs.mkdir(memoryDir, { recursive: true });

  const entry: TokenUsageRecord = {
    id: makeId(),
    label: params.label,
    tokensUsed: Math.trunc(total),
    ...(usage.input != null && usage.input > 0 && { inputTokens: Math.trunc(usage.input) }),
    ...(usage.output != null && usage.output > 0 && { outputTokens: Math.trunc(usage.output) }),
    ...(usage.cacheRead != null &&
      usage.cacheRead > 0 && { cacheReadTokens: Math.trunc(usage.cacheRead) }),
    ...(usage.cacheWrite != null &&
      usage.cacheWrite > 0 && { cacheWriteTokens: Math.trunc(usage.cacheWrite) }),
    model: params.model,
    provider: params.provider,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    createdAt: new Date().toISOString(),
  };

  const queued = writeQueues.get(file) ?? Promise.resolve();
  const next = queued.then(() => appendRecord(file, entry));
  writeQueues.set(
    file,
    next.catch(() => {}),
  );
  await next;
}
