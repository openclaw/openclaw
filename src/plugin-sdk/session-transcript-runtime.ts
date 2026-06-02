import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import {
  loadTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const SESSION_TRANSCRIPT_MEMORY_HIT_PREFIX = "transcript";

export type SessionTranscriptEvent = unknown;

export type SessionTranscriptIdentity = {
  agentId: string;
  memoryKey: SessionTranscriptMemoryHitKey;
  sessionId: string;
  sessionKey: string;
};

export type SessionTranscriptMemoryHitIdentity = {
  agentId: string;
  key: SessionTranscriptMemoryHitKey;
  sessionId: string;
};

export type SessionTranscriptMemoryHitKey = `transcript:${string}:${string}`;

export type SessionTranscriptReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  threadId?: string | number;
};

export type SessionTranscriptMemoryHitKeyParams = {
  agentId: string;
  sessionId: string;
};

export type ResolveSessionTranscriptMemoryHitKeyParams = {
  includeSyntheticFallback?: boolean;
  key: string;
  store: Record<string, SessionEntry>;
};

function requireMemoryKeySegment(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Cannot build session transcript memory hit key without ${label}.`);
  }
  return encodeURIComponent(normalized);
}

function decodeMemoryKeySegment(value: string): string | null {
  try {
    return normalizeOptionalString(decodeURIComponent(value)) ?? null;
  } catch {
    return null;
  }
}

function syntheticSessionKey(identity: SessionTranscriptMemoryHitIdentity): string {
  return `agent:${identity.agentId}:${identity.sessionId}`;
}

/**
 * Builds the storage-neutral memory hit key for one session transcript.
 */
export function formatSessionTranscriptMemoryHitKey(
  params: SessionTranscriptMemoryHitKeyParams,
): SessionTranscriptMemoryHitKey {
  const agentId = requireMemoryKeySegment(normalizeAgentId(params.agentId), "agentId");
  const sessionId = requireMemoryKeySegment(params.sessionId, "sessionId");
  return `${SESSION_TRANSCRIPT_MEMORY_HIT_PREFIX}:${agentId}:${sessionId}`;
}

/**
 * Parses a storage-neutral session transcript memory hit key.
 */
export function parseSessionTranscriptMemoryHitKey(
  key: string,
): SessionTranscriptMemoryHitIdentity | null {
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== SESSION_TRANSCRIPT_MEMORY_HIT_PREFIX) {
    return null;
  }
  const agentId = decodeMemoryKeySegment(parts[1] ?? "");
  const sessionId = decodeMemoryKeySegment(parts[2] ?? "");
  if (!agentId || !sessionId) {
    return null;
  }
  return {
    agentId: normalizeAgentId(agentId),
    key: formatSessionTranscriptMemoryHitKey({ agentId, sessionId }),
    sessionId,
  };
}

/**
 * Resolves the public identity for a transcript without returning its file path.
 */
export async function resolveSessionTranscriptIdentity(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptIdentity> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  };
}

/**
 * Reads transcript events by public session identity instead of file path.
 */
export async function readSessionTranscriptEvents(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptEvent[]> {
  return await loadTranscriptEvents(params);
}

/**
 * Maps a storage-neutral memory hit key back to visible session store keys.
 */
export function resolveSessionTranscriptMemoryHitKeyToSessionKeys(
  params: ResolveSessionTranscriptMemoryHitKeyParams,
): string[] {
  const identity = parseSessionTranscriptMemoryHitKey(params.key);
  if (!identity) {
    return [];
  }
  const matches = Object.entries(params.store)
    .filter(([sessionKey, entry]) => {
      return (
        entry.sessionId === identity.sessionId &&
        normalizeAgentId(resolveAgentIdFromSessionKey(sessionKey)) === identity.agentId
      );
    })
    .map(([sessionKey]) => sessionKey);
  const deduped = uniqueStrings(matches);
  if (deduped.length > 0) {
    return deduped;
  }
  return params.includeSyntheticFallback === false ? [] : [syntheticSessionKey(identity)];
}
