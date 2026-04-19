/**
 * Minions — BullMQ-inspired durable job queue for openclaw subagents, ACP
 * sessions, CLI runs, and cron ticks. Backed by node:sqlite with WAL and
 * BEGIN IMMEDIATE writer serialization.
 *
 * Ported from GBrain's Postgres-backed original; see docs/internals/minions.md
 * for dialect notes.
 *
 *   const queue = new MinionQueue(store);
 *   const job = await queue.add("subagent.spawn", { sessionKey, runId });
 *
 *   const worker = new MinionWorker(store);
 *   worker.register("subagent.spawn", async (job) => {
 *     // handler body
 *     return { ok: true };
 *   });
 *   await worker.start();
 */

export type MinionJobStatus =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "dead"
  | "cancelled"
  | "waiting-children"
  | "paused"
  | "attached"
  | "cancelling";

export const MINION_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "dead",
  "cancelled",
] as const satisfies readonly MinionJobStatus[];

export type MinionTerminalStatus = (typeof MINION_TERMINAL_STATUSES)[number];

export function isTerminalStatus(status: MinionJobStatus): status is MinionTerminalStatus {
  return (MINION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type BackoffType = "fixed" | "exponential";

export type ChildFailPolicy = "fail_parent" | "remove_dep" | "ignore" | "continue";

export interface MinionJob {
  id: number;
  name: string;
  queue: string;
  status: MinionJobStatus;
  priority: number;
  data: Record<string, unknown>;

  maxAttempts: number;
  attemptsMade: number;
  attemptsStarted: number;
  backoffType: BackoffType;
  backoffDelay: number;
  backoffJitter: number;

  stalledCounter: number;
  maxStalled: number;
  lockToken: string | null;
  lockUntil: number | null;

  delayUntil: number | null;

  parentJobId: number | null;
  onChildFail: ChildFailPolicy;

  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;

  depth: number;
  maxChildren: number | null;
  timeoutMs: number | null;
  timeoutAt: number | null;
  removeOnComplete: boolean;
  removeOnFail: boolean;
  idempotencyKey: string | null;

  handlerPid: number | null;

  result: Record<string, unknown> | null;
  progress: unknown;
  errorText: string | null;
  stacktrace: string[];

  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface MinionJobInput {
  name: string;
  data?: Record<string, unknown>;
  queue?: string;
  priority?: number;
  maxAttempts?: number;
  backoffType?: BackoffType;
  backoffDelay?: number;
  backoffJitter?: number;
  delay?: number;
  parentJobId?: number;
  onChildFail?: ChildFailPolicy;

  maxChildren?: number;
  timeoutMs?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  maxSpawnDepth?: number;
  idempotencyKey?: string;
}

export interface MinionQueueOpts {
  maxSpawnDepth?: number;
  maxAttachmentBytes?: number;
}

export interface MinionWorkerOpts {
  queue?: string;
  concurrency?: number;
  lockDuration?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
  pollInterval?: number;
  progressFlushInterval?: number;
}

export interface TokenUpdate {
  input?: number;
  output?: number;
  cacheRead?: number;
}

export interface InboxMessage {
  id: number;
  jobId: number;
  sender: string;
  payload: unknown;
  sentAt: number;
  readAt: number | null;
}

export interface ChildDoneMessage {
  type: "child_done";
  childId: number;
  jobName: string;
  result: unknown;
}

export interface AttachmentInput {
  filename: string;
  contentType: string;
  /** Base64-encoded bytes; validated at add time. */
  contentBase64: string;
}

export interface Attachment {
  id: number;
  jobId: number;
  filename: string;
  contentType: string;
  storageUri: string | null;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

export type TranscriptEntry =
  | { type: "log"; message: string; ts: string }
  | { type: "tool_call"; tool: string; argsSize: number; resultSize: number; ts: string }
  | { type: "llm_turn"; model: string; tokensIn: number; tokensOut: number; ts: string }
  | { type: "error"; message: string; stack?: string; ts: string };

export interface MinionJobContext {
  id: number;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
  /** Fires when the row is cancelled or the lock is lost. Cooperative cancellation. */
  signal: AbortSignal;
  updateProgress(progress: unknown): Promise<void>;
  updateTokens(tokens: TokenUpdate): Promise<void>;
  log(message: string | TranscriptEntry): Promise<void>;
  isActive(): Promise<boolean>;
  readInbox(): Promise<InboxMessage[]>;
}

export type MinionHandler = (job: MinionJobContext) => Promise<unknown>;

/**
 * Throw from a handler to skip retry and move straight to `dead`. Retry with
 * backoff is the default for any other thrown error.
 */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecoverableError";
  }
}

// ---------------------------------------------------------------------------
// SQLite row shapes (internal). Times are milliseconds since epoch (INTEGER).
// ---------------------------------------------------------------------------

export type MinionJobRow = {
  id: number | bigint;
  name: string;
  queue: string;
  status: MinionJobStatus;
  priority: number | bigint;
  data: string | null;
  max_attempts: number | bigint;
  attempts_made: number | bigint;
  attempts_started: number | bigint;
  backoff_type: BackoffType;
  backoff_delay: number | bigint;
  backoff_jitter: number;
  stalled_counter: number | bigint;
  max_stalled: number | bigint;
  lock_token: string | null;
  lock_until: number | bigint | null;
  delay_until: number | bigint | null;
  parent_job_id: number | bigint | null;
  on_child_fail: ChildFailPolicy;
  tokens_input: number | bigint;
  tokens_output: number | bigint;
  tokens_cache_read: number | bigint;
  depth: number | bigint;
  max_children: number | bigint | null;
  timeout_ms: number | bigint | null;
  timeout_at: number | bigint | null;
  remove_on_complete: number | bigint;
  remove_on_fail: number | bigint;
  idempotency_key: string | null;
  handler_pid: number | bigint | null;
  result: string | null;
  progress: string | null;
  error_text: string | null;
  stacktrace: string | null;
  created_at: number | bigint;
  started_at: number | bigint | null;
  finished_at: number | bigint | null;
  updated_at: number | bigint;
};

export type MinionInboxRow = {
  id: number | bigint;
  job_id: number | bigint;
  sender: string;
  payload: string | null;
  sent_at: number | bigint;
  read_at: number | bigint | null;
};

export type MinionAttachmentRow = {
  id: number | bigint;
  job_id: number | bigint;
  filename: string;
  content_type: string;
  storage_uri: string | null;
  size_bytes: number | bigint;
  sha256: string;
  created_at: number | bigint;
};

function coerceNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function coerceNullableNumber(value: number | bigint | null): number | null {
  return value == null ? null : coerceNumber(value);
}

function parseJsonOrNull<T>(value: string | null, fallback: T): T {
  if (value == null) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToMinionJob(row: MinionJobRow): MinionJob {
  return {
    id: coerceNumber(row.id),
    name: row.name,
    queue: row.queue,
    status: row.status,
    priority: coerceNumber(row.priority),
    data: parseJsonOrNull(row.data, {} as Record<string, unknown>),
    maxAttempts: coerceNumber(row.max_attempts),
    attemptsMade: coerceNumber(row.attempts_made),
    attemptsStarted: coerceNumber(row.attempts_started),
    backoffType: row.backoff_type,
    backoffDelay: coerceNumber(row.backoff_delay),
    backoffJitter: row.backoff_jitter,
    stalledCounter: coerceNumber(row.stalled_counter),
    maxStalled: coerceNumber(row.max_stalled),
    lockToken: row.lock_token,
    lockUntil: coerceNullableNumber(row.lock_until),
    delayUntil: coerceNullableNumber(row.delay_until),
    parentJobId: coerceNullableNumber(row.parent_job_id),
    onChildFail: row.on_child_fail,
    tokensInput: coerceNumber(row.tokens_input),
    tokensOutput: coerceNumber(row.tokens_output),
    tokensCacheRead: coerceNumber(row.tokens_cache_read),
    depth: coerceNumber(row.depth),
    maxChildren: coerceNullableNumber(row.max_children),
    timeoutMs: coerceNullableNumber(row.timeout_ms),
    timeoutAt: coerceNullableNumber(row.timeout_at),
    removeOnComplete: coerceNumber(row.remove_on_complete) === 1,
    removeOnFail: coerceNumber(row.remove_on_fail) === 1,
    idempotencyKey: row.idempotency_key,
    handlerPid: coerceNullableNumber(row.handler_pid),
    result: parseJsonOrNull(row.result, null as Record<string, unknown> | null),
    progress: parseJsonOrNull(row.progress, null as unknown),
    errorText: row.error_text,
    stacktrace: parseJsonOrNull(row.stacktrace, [] as string[]),
    createdAt: coerceNumber(row.created_at),
    startedAt: coerceNullableNumber(row.started_at),
    finishedAt: coerceNullableNumber(row.finished_at),
    updatedAt: coerceNumber(row.updated_at),
  };
}

export function rowToInboxMessage(row: MinionInboxRow): InboxMessage {
  return {
    id: coerceNumber(row.id),
    jobId: coerceNumber(row.job_id),
    sender: row.sender,
    payload: parseJsonOrNull(row.payload, null as unknown),
    sentAt: coerceNumber(row.sent_at),
    readAt: coerceNullableNumber(row.read_at),
  };
}

export function rowToAttachment(row: MinionAttachmentRow): Attachment {
  return {
    id: coerceNumber(row.id),
    jobId: coerceNumber(row.job_id),
    filename: row.filename,
    contentType: row.content_type,
    storageUri: row.storage_uri,
    sizeBytes: coerceNumber(row.size_bytes),
    sha256: row.sha256,
    createdAt: coerceNumber(row.created_at),
  };
}
