import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
  type SessionFilePathOptions,
} from "./paths.js";
import {
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

type SessionLifecycleEntry = Pick<
  SessionEntry,
  "sessionId" | "sessionFile" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt"
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
  pathOptions?: SessionFilePathOptions;
}): number | undefined {
  const sessionId = params.entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  void params.pathOptions;
  const storedSessionFile = params.entry?.sessionFile?.trim();
  const sessionFile = isSqliteSessionTranscriptLocator(storedSessionFile)
    ? storedSessionFile
    : createSqliteSessionTranscriptLocator({ agentId: params.agentId, sessionId });
  const scope = resolveSqliteSessionTranscriptScope({
    agentId: params.agentId,
    sessionId,
    transcriptPath: sessionFile,
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
  pathOptions?: SessionFilePathOptions;
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
        pathOptions: params.pathOptions,
      }),
    lastInteractionAt: resolveTimestamp(entry.lastInteractionAt),
  };
}
