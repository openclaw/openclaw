import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";

export { loadCombinedSessionEntriesForGateway } from "../config/sessions/combined-session-entries-gateway.js";

export type SessionTranscriptHitIdentity = {
  stem: string;
  ownerAgentId?: string;
};

const TRANSCRIPT_KEY_PREFIX = "transcript:";

function parseSessionsPath(hitPath: string): { base: string; ownerAgentId?: string } | null {
  if (!hitPath.startsWith(TRANSCRIPT_KEY_PREFIX)) {
    return null;
  }
  const parts = hitPath.slice(TRANSCRIPT_KEY_PREFIX.length).split(":");
  const agentId = parts.shift()?.trim();
  const sessionId = parts.join(":").trim();
  if (!agentId || !sessionId) {
    return null;
  }
  return { base: sessionId, ownerAgentId: normalizeAgentId(agentId) };
}

/**
 * Derive transcript stem `S` from a memory search hit key for `source === "sessions"`.
 * Session memory hits use opaque SQLite-backed keys: `transcript:<agent>:<session>`.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}

export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const parsed = parseSessionsPath(hitPath);
  return parsed ? { stem: parsed.base, ownerAgentId: parsed.ownerAgentId } : null;
}

/**
 * Map transcript stem to canonical session row keys across all agents.
 * Session tools visibility and agent-to-agent policy are enforced by the caller (e.g.
 * `createSessionVisibilityGuard`), including cross-agent cases.
 */
export function resolveTranscriptStemToSessionKeys(params: {
  entries: Record<string, SessionEntry>;
  stem: string;
}): string[] {
  const matches: string[] = [];

  for (const [sessionKey, entry] of Object.entries(params.entries)) {
    if (entry.sessionId === params.stem) {
      matches.push(sessionKey);
    }
  }
  const deduped = [...new Set(matches)];
  if (deduped.length > 0) {
    return deduped;
  }
  return [];
}
