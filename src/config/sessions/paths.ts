import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";

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

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!SAFE_SESSION_ID_RE.test(trimmed)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

function resolveSessionsDir(opts?: { agentId?: string; sessionsDir?: string }): string {
  const sessionsDir = opts?.sessionsDir?.trim();
  if (sessionsDir) {
    return path.resolve(sessionsDir);
  }
  return resolveAgentSessionsDir(opts?.agentId);
}

function resolvePathWithinSessionsDir(sessionsDir: string, candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error("Session file path must not be empty");
  }
  const resolvedBase = path.resolve(sessionsDir);
  const resolvedCandidate = path.resolve(resolvedBase, trimmed);

  // Security check: ensure the resolved path is within the sessions directory.
  // Handle both relative paths and absolute paths that may already be within the directory.
  // For absolute paths, check if they start with the sessions directory prefix.
  // For relative paths, check if they don't escape with "..".
  if (path.isAbsolute(trimmed)) {
    // Candidate is an absolute path - verify it's within the sessions directory
    const normalizedBase = resolvedBase + path.sep;
    if (
      !resolvedCandidate.startsWith(normalizedBase) &&
      resolvedCandidate !== resolvedBase
    ) {
      throw new Error("Session file path must be within sessions directory");
    }
  } else {
    // Candidate is a relative path - use the original relative path check
    const relative = path.relative(resolvedBase, resolvedCandidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Session file path must be within sessions directory");
    }
  }
  return resolvedCandidate;
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
  return resolvePathWithinSessionsDir(sessionsDir, fileName);
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
  opts?: { agentId?: string; sessionsDir?: string },
): string {
  const sessionsDir = resolveSessionsDir(opts);
  const candidate = entry?.sessionFile?.trim();
  if (candidate) {
    return resolvePathWithinSessionsDir(sessionsDir, candidate);
  }
  return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}

export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!store) {
    return resolveDefaultSessionStorePath(agentId);
  }
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      return path.resolve(
        expandHomePrefix(expanded, {
          home: resolveRequiredHomeDir(process.env, os.homedir),
          env: process.env,
          homedir: os.homedir,
        }),
      );
    }
    return path.resolve(expanded);
  }
  if (store.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(store, {
        home: resolveRequiredHomeDir(process.env, os.homedir),
        env: process.env,
        homedir: os.homedir,
      }),
    );
  }
  return path.resolve(store);
}
