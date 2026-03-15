import { randomBytes } from "crypto";
import fs from "fs/promises";
import path from "path";
import { type FileLockOptions, withFileLock } from "../infra/file-lock.js";

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
// process.  Two concurrent OpenClaw processes targeting the same
// workspaceDir can still race, so we use an advisory O_EXCL lock provided
// by the shared withFileLock helper in plugin-sdk/file-lock.ts.
//
// That implementation:
//   • stores {pid, createdAt} so waiters can detect a crashed holder
//   • treats empty/unparseable lock content as stale (crash during open→write)
//   • re-verifies the lock inode before removing it so a slow waiter's
//     unlink cannot delete a fresh lock from another process
//   • uses exponential backoff with jitter capped at stale ms
// ---------------------------------------------------------------------------
const APPEND_LOCK_OPTIONS: FileLockOptions = {
  // ~100 retries × 50 ms ≈ 5 s total — matches the previous LOCK_TIMEOUT_MS.
  retries: {
    retries: 100,
    factor: 1,
    minTimeout: 50,
    maxTimeout: 50,
  },
  stale: 5_000,
};

async function appendRecord(file: string, entry: TokenUsageRecord): Promise<void> {
  await withFileLock(file, APPEND_LOCK_OPTIONS, async () => {
    const records = await readJsonArray(file);
    records.push(entry);
    // Write to a sibling temp file then atomically rename into place so that
    // a crash or kill during the write never leaves token-usage.json truncated.
    // rename(2) is atomic on POSIX when src and dst are on the same filesystem,
    // which is guaranteed here because both paths share the same directory.
    const tmp = `${file}.tmp.${randomBytes(4).toString("hex")}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(records, null, 2));
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
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
