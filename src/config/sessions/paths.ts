import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { isCompactionCheckpointTranscriptFileName } from "./artifacts.js";

export type SessionTranscriptLocatorOptions = {
  agentId?: string;
};

export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
export const SQLITE_SESSION_TRANSCRIPT_LOCATOR_PREFIX = "sqlite-transcript://";

export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (
    !SAFE_SESSION_ID_RE.test(trimmed) ||
    isCompactionCheckpointTranscriptFileName(`${trimmed}.jsonl`)
  ) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

export function createSqliteSessionTranscriptLocator(params: {
  agentId?: string;
  sessionId: string;
  topicId?: string | number;
}): string {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const sessionId = validateSessionId(params.sessionId);
  const safeTopicId =
    typeof params.topicId === "string"
      ? encodeURIComponent(params.topicId)
      : typeof params.topicId === "number"
        ? String(params.topicId)
        : undefined;
  const topicSuffix = safeTopicId !== undefined ? `?topic=${safeTopicId}` : "";
  return `${SQLITE_SESSION_TRANSCRIPT_LOCATOR_PREFIX}${encodeURIComponent(
    agentId,
  )}/${encodeURIComponent(sessionId)}${topicSuffix}`;
}

export function parseSqliteSessionTranscriptLocator(locator: string):
  | {
      agentId: string;
      sessionId: string;
      topicId?: string;
    }
  | undefined {
  const trimmed = locator.trim();
  if (!trimmed.startsWith(SQLITE_SESSION_TRANSCRIPT_LOCATOR_PREFIX)) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    const agentId = decodeURIComponent(url.hostname).trim();
    const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/u, "")).trim();
    if (!rawPath) {
      return undefined;
    }
    const topicId = url.searchParams.get("topic") ?? undefined;
    return {
      agentId: normalizeAgentId(agentId),
      sessionId: validateSessionId(rawPath),
      ...(topicId ? { topicId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function isSqliteSessionTranscriptLocator(locator: string | undefined): boolean {
  return typeof locator === "string" && parseSqliteSessionTranscriptLocator(locator) !== undefined;
}

export function resolveSessionTranscriptLocator(
  sessionId: string,
  entry?: { transcriptLocator?: string },
  opts?: SessionTranscriptLocatorOptions,
): string {
  void entry;
  return createSqliteSessionTranscriptLocator({ agentId: opts?.agentId, sessionId });
}
