import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";
function resolveAgentSessionsDir(agentId, env = process.env, homedir = () => resolveRequiredHomeDir(env, os.homedir)) {
    const root = resolveStateDir(env, homedir);
    const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
    return path.join(root, "agents", id, "sessions");
}
export function resolveSessionTranscriptsDir(env = process.env, homedir = () => resolveRequiredHomeDir(env, os.homedir)) {
    return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}
export function resolveSessionTranscriptsDirForAgent(agentId, env = process.env, homedir = () => resolveRequiredHomeDir(env, os.homedir)) {
    return resolveAgentSessionsDir(agentId, env, homedir);
}
export function resolveDefaultSessionStorePath(agentId) {
    return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}
const MULTI_STORE_PATH_SENTINEL = "(multiple)";
export function resolveSessionFilePathOptions(params) {
    const agentId = params.agentId?.trim();
    const storePath = params.storePath?.trim();
    if (storePath && storePath !== MULTI_STORE_PATH_SENTINEL) {
        const sessionsDir = path.dirname(path.resolve(storePath));
        return agentId ? { sessionsDir, agentId } : { sessionsDir };
    }
    if (agentId) {
        return { agentId };
    }
    return undefined;
}
export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
export function validateSessionId(sessionId) {
    const trimmed = sessionId.trim();
    if (!SAFE_SESSION_ID_RE.test(trimmed)) {
        throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return trimmed;
}
function resolveSessionsDir(opts) {
    const sessionsDir = opts?.sessionsDir?.trim();
    if (sessionsDir) {
        return path.resolve(sessionsDir);
    }
    return resolveAgentSessionsDir(opts?.agentId);
}
function resolvePathFromAgentSessionsDir(agentSessionsDir, candidateAbsPath) {
    const agentBase = safeRealpathSync(path.resolve(agentSessionsDir)) ?? path.resolve(agentSessionsDir);
    const realCandidate = safeRealpathSync(candidateAbsPath) ?? candidateAbsPath;
    const relative = path.relative(agentBase, realCandidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return undefined;
    }
    return path.resolve(agentBase, relative);
}
function resolveSiblingAgentSessionsDir(baseSessionsDir, agentId) {
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
function resolveAgentSessionsPathParts(candidateAbsPath) {
    const normalized = path.normalize(path.resolve(candidateAbsPath));
    const parts = normalized.split(path.sep).filter(Boolean);
    const sessionsIndex = parts.lastIndexOf("sessions");
    if (sessionsIndex < 2 || parts[sessionsIndex - 2] !== "agents") {
        return null;
    }
    return { parts, sessionsIndex };
}
function extractAgentIdFromAbsoluteSessionPath(candidateAbsPath) {
    const parsed = resolveAgentSessionsPathParts(candidateAbsPath);
    if (!parsed) {
        return undefined;
    }
    const { parts, sessionsIndex } = parsed;
    const agentId = parts[sessionsIndex - 1];
    return agentId || undefined;
}
function resolveStructuralSessionFallbackPath(candidateAbsPath, expectedAgentId) {
    const parsed = resolveAgentSessionsPathParts(candidateAbsPath);
    if (!parsed) {
        return undefined;
    }
    const { parts, sessionsIndex } = parsed;
    const agentIdPart = parts[sessionsIndex - 1];
    if (!agentIdPart) {
        return undefined;
    }
    const normalizedAgentId = normalizeAgentId(agentIdPart);
    if (normalizedAgentId !== agentIdPart.toLowerCase()) {
        return undefined;
    }
    if (normalizedAgentId !== normalizeAgentId(expectedAgentId)) {
        return undefined;
    }
    const relativeSegments = parts.slice(sessionsIndex + 1);
    // Session transcripts are stored as direct files in "sessions/".
    if (relativeSegments.length !== 1) {
        return undefined;
    }
    const fileName = relativeSegments[0];
    if (!fileName || fileName === "." || fileName === "..") {
        return undefined;
    }
    return path.normalize(path.resolve(candidateAbsPath));
}
function safeRealpathSync(filePath) {
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return undefined;
    }
}
function resolvePathWithinSessionsDir(sessionsDir, candidate, opts) {
    const trimmed = candidate.trim();
    if (!trimmed) {
        throw new Error("Session file path must not be empty");
    }
    const resolvedBase = path.resolve(sessionsDir);
    const realBase = safeRealpathSync(resolvedBase) ?? resolvedBase;
    // Normalize absolute paths that are within the sessions directory.
    // Older versions stored absolute sessionFile paths in sessions.json;
    // convert them to relative so the containment check passes.
    const realTrimmed = path.isAbsolute(trimmed) ? (safeRealpathSync(trimmed) ?? trimmed) : trimmed;
    const normalized = path.isAbsolute(realTrimmed)
        ? path.relative(realBase, realTrimmed)
        : realTrimmed;
    if (normalized.startsWith("..") && path.isAbsolute(realTrimmed)) {
        const tryAgentFallback = (agentId) => {
            const normalizedAgentId = normalizeAgentId(agentId);
            const siblingSessionsDir = resolveSiblingAgentSessionsDir(realBase, normalizedAgentId);
            if (siblingSessionsDir) {
                const siblingResolved = resolvePathFromAgentSessionsDir(siblingSessionsDir, realTrimmed);
                if (siblingResolved) {
                    return siblingResolved;
                }
            }
            return resolvePathFromAgentSessionsDir(resolveAgentSessionsDir(normalizedAgentId), realTrimmed);
        };
        const explicitAgentId = opts?.agentId?.trim();
        if (explicitAgentId) {
            const resolvedFromAgent = tryAgentFallback(explicitAgentId);
            if (resolvedFromAgent) {
                return resolvedFromAgent;
            }
        }
        const extractedAgentId = extractAgentIdFromAbsoluteSessionPath(realTrimmed);
        if (extractedAgentId) {
            const resolvedFromPath = tryAgentFallback(extractedAgentId);
            if (resolvedFromPath) {
                return resolvedFromPath;
            }
            // Cross-root compatibility for older absolute paths:
            // keep only canonical .../agents/<agentId>/sessions/<file> shapes.
            const structuralFallback = resolveStructuralSessionFallbackPath(realTrimmed, extractedAgentId);
            if (structuralFallback) {
                return structuralFallback;
            }
        }
    }
    if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
        throw new Error("Session file path must be within sessions directory");
    }
    return path.resolve(realBase, normalized);
}
export function resolveSessionTranscriptPathInDir(sessionId, sessionsDir, topicId) {
    const safeSessionId = validateSessionId(sessionId);
    const safeTopicId = typeof topicId === "string"
        ? encodeURIComponent(topicId)
        : typeof topicId === "number"
            ? String(topicId)
            : undefined;
    const fileName = safeTopicId !== undefined
        ? `${safeSessionId}-topic-${safeTopicId}.jsonl`
        : `${safeSessionId}.jsonl`;
    return resolvePathWithinSessionsDir(sessionsDir, fileName);
}
export function resolveSessionTranscriptPath(sessionId, agentId, topicId) {
    return resolveSessionTranscriptPathInDir(sessionId, resolveAgentSessionsDir(agentId), topicId);
}
export function resolveSessionFilePath(sessionId, entry, opts) {
    const sessionsDir = resolveSessionsDir(opts);
    const candidate = entry?.sessionFile?.trim();
    if (candidate) {
        try {
            return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
        }
        catch {
            // Keep handlers alive when persisted metadata is stale/corrupt.
        }
    }
    return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}
export function resolveStorePath(store, opts) {
    const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
    if (!store) {
        return resolveDefaultSessionStorePath(agentId);
    }
    if (store.includes("{agentId}")) {
        const expanded = store.replaceAll("{agentId}", agentId);
        if (expanded.startsWith("~")) {
            return path.resolve(expandHomePrefix(expanded, {
                home: resolveRequiredHomeDir(process.env, os.homedir),
                env: process.env,
                homedir: os.homedir,
            }));
        }
        return path.resolve(expanded);
    }
    if (store.startsWith("~")) {
        return path.resolve(expandHomePrefix(store, {
            home: resolveRequiredHomeDir(process.env, os.homedir),
            env: process.env,
            homedir: os.homedir,
        }));
    }
    return path.resolve(store);
}
