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
    return Array.isArray(parsed) ? (parsed as TokenUsageRecord[]) : [];
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
// Lock acquisition retries with a fixed interval up to LOCK_TIMEOUT_MS.
// If the holding process crashes the stale lock is removed after the
// timeout so subsequent callers are not permanently blocked.
// ---------------------------------------------------------------------------
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let fh: fs.FileHandle | undefined;
    try {
      // wx = O_WRONLY | O_CREAT | O_EXCL — fails if the file already exists
      fh = await fs.open(lockPath, "wx");
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
      // Another process holds the lock — wait and retry.
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  // Timeout: remove a potentially stale lock and make one final attempt.
  await fs.unlink(lockPath).catch(() => {});
  const records = await fn();
  return records;
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
