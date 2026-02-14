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

export type SessionFilePathOptions = {
  agentId?: string;
  sessionsDir?: string;
};

function isDefaultAgentSessionsDir(dir: string): boolean {
  const normalized = path.normalize(path.resolve(dir));
  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const tail = parts.slice(-3);
  return tail[0] === "agents" && Boolean(tail[1]) && tail[2] === "sessions";
}

export function resolveSessionFilePathOptions(params: {
  agentId?: string;
  storePath?: string;
}): SessionFilePathOptions | undefined {
  const agentId = params.agentId?.trim();
  const storePath = params.storePath?.trim();
  if (storePath) {
    const sessionsDir = path.dirname(path.resolve(storePath));
    if (agentId) {
      const expectedForAgent = path.dirname(resolveDefaultSessionStorePath(agentId));
      // If a default per-agent store path from a different agent leaked into this
      // code path, prefer the explicit agentId to avoid cross-agent containment
      // failures ("path must be within sessions directory").
      if (isDefaultAgentSessionsDir(sessionsDir) && sessionsDir !== expectedForAgent) {
        return { agentId };
      }
    }
    return { sessionsDir };
  }
  if (agentId) {
    return { agentId };
  }
  return undefined;
}

export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!SAFE_SESSION_ID_RE.test(trimmed)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

function resolveSessionsDir(opts?: SessionFilePathOptions): string {
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
  // Normalize absolute paths that are within the sessions directory.
  // Older versions stored absolute sessionFile paths in sessions.json;
  // convert them to relative so the containment check passes.
  const normalized = path.isAbsolute(trimmed) ? path.relative(resolvedBase, trimmed) : trimmed;
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Session file path must be within sessions directory");
  }
  return path.resolve(resolvedBase, normalized);
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
  opts?: SessionFilePathOptions,
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
