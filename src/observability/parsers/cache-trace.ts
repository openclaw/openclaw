import type { ParsedEvent, LogParser } from "./index.js";

/**
 * CacheTraceEvent type from src/agents/cache-trace.ts
 */
type CacheTraceStage =
  | "session:loaded"
  | "session:sanitized"
  | "session:limited"
  | "prompt:before"
  | "prompt:images"
  | "stream:context"
  | "session:after";

type CacheTraceEvent = {
  ts: string;
  seq: number;
  stage: CacheTraceStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  prompt?: string;
  system?: unknown;
  options?: Record<string, unknown>;
  model?: Record<string, unknown>;
  messages?: unknown[];
  messageCount?: number;
  messageRoles?: Array<string | undefined>;
  messageFingerprints?: string[];
  messagesDigest?: string;
  systemDigest?: string;
  note?: string;
  error?: string;
};

function isCacheTraceEvent(value: unknown): value is CacheTraceEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.ts === "string" && typeof obj.seq === "number" && typeof obj.stage === "string";
}

/**
 * Parses a single line of cache trace JSONL.
 */
export function parseCacheTraceLine(line: string, sourceFile: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isCacheTraceEvent(entry)) {
    return null;
  }

  // Build a message preview from available data
  let messagePreview: string | undefined;
  if (entry.note) {
    messagePreview = entry.note;
  } else if (entry.error) {
    messagePreview = `error: ${entry.error}`;
  } else if (entry.messageCount !== undefined) {
    messagePreview = `messages: ${entry.messageCount}`;
  }

  return {
    ts: entry.ts,
    sourceType: "cache-trace",
    sourceFile,
    eventType: `cache:${entry.stage}`,
    sessionId: entry.sessionId,
    runId: entry.runId,
    provider: entry.provider,
    modelId: entry.modelId,
    messagePreview: messagePreview?.slice(0, 500),
    rawJson: trimmed,
  };
}

/**
 * Cache trace parser for cache-trace.jsonl files.
 */
export const cacheTraceParser: LogParser = {
  sourceType: "cache-trace",
  parseLine: parseCacheTraceLine,
};
