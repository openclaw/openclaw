import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";
import { isCompactionCheckpointTranscriptFileName } from "./artifacts.js";

function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(agentId, env, homedir);
}

export type SessionFilePathOptions = {
  agentId?: string;
  sessionsDir?: string;
};

export function resolveSessionFilePathOptions(params: {
  agentId?: string;
  sessionsDir?: string;
}): SessionFilePathOptions | undefined {
  const agentId = params.agentId?.trim();
  const sessionsDir = params.sessionsDir?.trim();
  if (sessionsDir) {
    const resolvedSessionsDir = path.resolve(sessionsDir);
    return agentId
      ? { sessionsDir: resolvedSessionsDir, agentId }
      : { sessionsDir: resolvedSessionsDir };
  }
  if (agentId) {
    return { agentId };
  }
  return undefined;
}

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
  const fileName =
    safeTopicId !== undefined ? `${sessionId}-topic-${safeTopicId}.jsonl` : `${sessionId}.jsonl`;
  return `${SQLITE_SESSION_TRANSCRIPT_LOCATOR_PREFIX}${encodeURIComponent(agentId)}/${fileName}`;
}

export function parseSqliteSessionTranscriptLocator(locator: string):
  | {
      agentId: string;
      sessionId: string;
    }
  | undefined {
  const trimmed = locator.trim();
  if (!trimmed.startsWith(SQLITE_SESSION_TRANSCRIPT_LOCATOR_PREFIX)) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    const agentId = decodeURIComponent(url.hostname).trim();
    const fileName = decodeURIComponent(url.pathname.replace(/^\/+/u, "")).trim();
    if (!fileName.endsWith(".jsonl")) {
      return undefined;
    }
    const withoutExt = fileName.slice(0, -".jsonl".length);
    const topicIndex = withoutExt.indexOf("-topic-");
    const sessionId = topicIndex > 0 ? withoutExt.slice(0, topicIndex) : withoutExt;
    return {
      agentId: normalizeAgentId(agentId),
      sessionId: validateSessionId(sessionId),
    };
  } catch {
    return undefined;
  }
}

export function isSqliteSessionTranscriptLocator(locator: string | undefined): boolean {
  return typeof locator === "string" && parseSqliteSessionTranscriptLocator(locator) !== undefined;
}

export function resolveSessionTranscriptPathInDir(
  sessionId: string,
  sessionsDir: string,
  topicId?: string | number,
): string {
  const safeSessionId = validateSessionId(sessionId);
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId !== undefined
      ? `${safeSessionId}-topic-${safeTopicId}.jsonl`
      : `${safeSessionId}.jsonl`;
  return path.resolve(sessionsDir, fileName);
}

export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: string | number,
): string {
  return resolveSessionTranscriptPathInDir(sessionId, resolveAgentSessionsDir(agentId), topicId);
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  opts?: SessionFilePathOptions,
): string {
  const candidate = entry?.sessionFile?.trim();
  const parsed = candidate ? parseSqliteSessionTranscriptLocator(candidate) : undefined;
  if (
    parsed?.sessionId === sessionId &&
    (!opts?.agentId || parsed.agentId === normalizeAgentId(opts.agentId))
  ) {
    return candidate!;
  }
  return createSqliteSessionTranscriptLocator({ agentId: opts?.agentId, sessionId });
}
