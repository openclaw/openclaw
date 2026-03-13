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
  return `usage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

async function appendRecord(file: string, entry: TokenUsageRecord): Promise<void> {
  const records = await readJsonArray(file);
  records.push(entry);
  await fs.writeFile(file, JSON.stringify(records, null, 2));
}

// Per-file write queue: serialises concurrent recordTokenUsage() calls so that
// a fire-and-forget caller cannot cause two concurrent writers to read the same
// snapshot and overwrite each other's entry.
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
