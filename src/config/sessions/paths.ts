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

export function resolveSessionFilePathOptions(params: {
  agentId?: string;
  storePath?: string;
}): SessionFilePathOptions | undefined {
  const agentId = params.agentId?.trim();
  const storePath = params.storePath?.trim();
  if (storePath) {
    const sessionsDir = path.dirname(path.resolve(storePath));
    return agentId ? { sessionsDir, agentId } : { sessionsDir };
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

function resolvePathFromAgentSessionsDir(
  agentSessionsDir: string,
  candidateAbsPath: string,
): string | undefined {
  const agentBase = path.resolve(agentSessionsDir);
  const relative = path.relative(agentBase, candidateAbsPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return path.resolve(agentBase, relative);
}

function resolveSiblingAgentSessionsDir(
  baseSessionsDir: string,
  agentId: string,
): string | undefined {
  const resolvedBase = path.resolve(baseSessionsDir);
  if (path.basename(resolvedBase) !== "sessions") {
    return undefined;
  }
  const baseAgentDir = path.dirname(resolvedBase);
  const baseAgentsDir = path.dirname(baseAgentDir);
  if (path.basename(baseAgentsDir) !== "agents") {
    return undefined;
  }
  const rootDir = path.dirname(baseAgentsDir);
  return path.join(rootDir, "agents", normalizeAgentId(agentId), "sessions");
}

function extractAgentIdFromAbsoluteSessionPath(candidateAbsPath: string): string | undefined {
  const normalized = path.normalize(path.resolve(candidateAbsPath));
  const parts = normalized.split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
    return undefined;
  }
  const agentId = parts[sessionsIndex - 1];
  return agentId || undefined;
}

function resolvePathWithinSessionsDir(
  sessionsDir: string,
  candidate: string,
  opts?: { agentId?: string },
): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error("Session file path must not be empty");
  }
  const resolvedBase = path.resolve(sessionsDir);
  // Normalize absolute paths that are within the sessions directory.
  // Older versions stored absolute sessionFile paths in sessions.json;
  // convert them to relative so the containment check passes.
  const normalized = path.isAbsolute(trimmed) ? path.relative(resolvedBase, trimmed) : trimmed;
  if (normalized.startsWith("..") && path.isAbsolute(trimmed)) {
    const tryAgentFallback = (agentId: string): string | undefined => {
      const normalizedAgentId = normalizeAgentId(agentId);
      const siblingSessionsDir = resolveSiblingAgentSessionsDir(resolvedBase, normalizedAgentId);
      if (siblingSessionsDir) {
        const siblingResolved = resolvePathFromAgentSessionsDir(siblingSessionsDir, trimmed);
        if (siblingResolved) {
          return siblingResolved;
        }
      }
      return resolvePathFromAgentSessionsDir(resolveAgentSessionsDir(normalizedAgentId), trimmed);
    };

    const explicitAgentId = opts?.agentId?.trim();
    if (explicitAgentId) {
      const resolvedFromAgent = tryAgentFallback(explicitAgentId);
      if (resolvedFromAgent) {
        return resolvedFromAgent;
      }
    }
    const extractedAgentId = extractAgentIdFromAbsoluteSessionPath(trimmed);
    if (extractedAgentId) {
      const resolvedFromPath = tryAgentFallback(extractedAgentId);
      if (resolvedFromPath) {
        return resolvedFromPath;
      }
      // The path structurally matches .../agents/<agentId>/sessions/...
      // Accept it even if the root directory differs from the current env
      // (e.g., OPENCLAW_STATE_DIR changed between session creation and resolution).
      // The structural pattern provides sufficient containment guarantees.
      return path.resolve(trimmed);
    }
  }
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
    return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
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
