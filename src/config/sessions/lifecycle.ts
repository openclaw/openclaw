import {
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

type SessionLifecycleEntry = Pick<
  SessionEntry,
  "sessionId" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt"
>;

function resolveTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return resolveTimestamp(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function readSessionHeaderStartedAtMs(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
}): number | undefined {
  const sessionId = params.entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const scope = resolveSqliteSessionTranscriptScope({
    agentId: params.agentId,
    sessionId,
  });
  if (!scope) {
    return undefined;
  }
  try {
    const header = loadSqliteSessionTranscriptEvents(scope)[0]?.event as
      | {
          type?: unknown;
          id?: unknown;
          timestamp?: unknown;
        }
      | undefined;
    if (!header) {
      return undefined;
    }
    const parsed = header as {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
    };
    if (parsed.type !== "session") {
      return undefined;
    }
    if (typeof parsed.id === "string" && parsed.id.trim() && parsed.id !== sessionId) {
      return undefined;
    }
    return parseTimestampMs(parsed.timestamp);
  } catch {
    return undefined;
  }
}

export function resolveSessionLifecycleTimestamps(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
}): { sessionStartedAt?: number; lastInteractionAt?: number } {
  const entry = params.entry;
  if (!entry) {
    return {};
  }
  return {
    sessionStartedAt:
      resolveTimestamp(entry.sessionStartedAt) ??
      readSessionHeaderStartedAtMs({
        entry,
        agentId: params.agentId,
      }),
    lastInteractionAt: resolveTimestamp(entry.lastInteractionAt),
  };
}
