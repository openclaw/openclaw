import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";

const transcriptAppendQueues = new Map<string, Promise<void>>();

async function loadCurrentSessionVersion(): Promise<number> {
  return (await import("../../agents/transcript/session-transcript-contract.js"))
    .CURRENT_SESSION_VERSION;
}

function normalizeRequiredScope(params: {
  transcriptPath: string;
  agentId?: string;
  sessionId?: string;
}): { agentId: string; sessionId: string; queueKey: string } {
  const agentId = params.agentId?.trim();
  const sessionId = params.sessionId?.trim();
  if (!agentId || !sessionId) {
    throw new Error(
      `SQLite transcript appends require agentId and sessionId; path-only transcript writes are retired (${params.transcriptPath})`,
    );
  }
  return {
    agentId,
    sessionId,
    queueKey: `${agentId}\0${sessionId}`,
  };
}

async function withTranscriptAppendQueue<T>(queueKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = transcriptAppendQueues.get(queueKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  transcriptAppendQueues.set(queueKey, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (transcriptAppendQueues.get(queueKey) === tail) {
      transcriptAppendQueues.delete(queueKey);
    }
  }
}

function latestParentLinkedEntryId(events: unknown[]): string | undefined {
  for (const event of events.toReversed()) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const record = event as { type?: unknown; id?: unknown; parentId?: unknown };
    if (
      record.type !== "session" &&
      typeof record.id === "string" &&
      Object.hasOwn(record, "parentId")
    ) {
      return record.id;
    }
  }
  return undefined;
}

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const key = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key.trim() ? key : undefined;
}

function findExistingMessageIdForIdempotencyKey(
  events: unknown[],
  idempotencyKey: string | undefined,
): string | undefined {
  if (!idempotencyKey) {
    return undefined;
  }
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const record = event as { id?: unknown; message?: { idempotencyKey?: unknown } };
    if (record.message?.idempotencyKey === idempotencyKey && typeof record.id === "string") {
      return record.id;
    }
  }
  return undefined;
}

async function appendSessionHeaderIfEmpty(params: {
  agentId: string;
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  now: number;
}): Promise<unknown[]> {
  const existing = loadSqliteSessionTranscriptEvents({
    agentId: params.agentId,
    sessionId: params.sessionId,
  }).map((entry) => entry.event);
  if (existing.length > 0) {
    return existing;
  }

  const currentSessionVersion = await loadCurrentSessionVersion();
  const header = {
    type: "session",
    version: currentSessionVersion,
    id: params.sessionId,
    timestamp: new Date(params.now).toISOString(),
    cwd: params.cwd ?? process.cwd(),
  };
  appendSqliteSessionTranscriptEvent({
    agentId: params.agentId,
    sessionId: params.sessionId,
    transcriptPath: path.resolve(params.transcriptPath),
    event: header,
    now: () => params.now,
  });
  return [header];
}

export async function appendSessionTranscriptMessage(params: {
  transcriptPath: string;
  message: unknown;
  agentId?: string;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{ messageId: string }> {
  const scope = normalizeRequiredScope(params);
  return await withTranscriptAppendQueue(scope.queueKey, async () => {
    const now = params.now ?? Date.now();
    const events = await appendSessionHeaderIfEmpty({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      transcriptPath: params.transcriptPath,
      cwd: params.cwd,
      now,
    });
    const existingMessageId = findExistingMessageIdForIdempotencyKey(
      events,
      readMessageIdempotencyKey(params.message),
    );
    if (existingMessageId) {
      return { messageId: existingMessageId };
    }
    const messageId = randomUUID();
    const entry = {
      type: "message",
      id: messageId,
      parentId: latestParentLinkedEntryId(events) ?? null,
      timestamp: new Date(now).toISOString(),
      message: params.message,
    };
    appendSqliteSessionTranscriptEvent({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      transcriptPath: path.resolve(params.transcriptPath),
      event: entry,
      now: () => now,
    });
    return { messageId };
  });
}
