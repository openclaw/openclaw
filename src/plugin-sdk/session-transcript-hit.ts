import path from "node:path";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";

export { loadCombinedSessionEntriesForGateway } from "../config/sessions/combined-session-entries-gateway.js";

export type SessionTranscriptHitIdentity = {
  stem: string;
  ownerAgentId?: string;
};

function parseSessionsPath(hitPath: string): { base: string; ownerAgentId?: string } {
  const normalized = hitPath.replace(/\\/g, "/");
  const fromSessionsRoot = normalized.startsWith("sessions/")
    ? normalized.slice("sessions/".length)
    : normalized;
  const parts = fromSessionsRoot.split("/").filter(Boolean);
  const base = path.posix.basename(fromSessionsRoot);
  const ownerAgentId =
    normalized.startsWith("sessions/") && parts.length === 2
      ? normalizeAgentId(parts[0])
      : undefined;
  return { base, ownerAgentId };
}

/**
 * Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
 * Builtin index uses `sessions/<agent>/<session>`; QMD exports use `<stem>.md`.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}

export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const { base, ownerAgentId } = parseSessionsPath(hitPath);
  if (base.endsWith(".md")) {
    const stem = base.slice(0, -".md".length);
    return stem ? { stem } : null;
  }
  if (hitPath.replace(/\\/g, "/").startsWith("sessions/") && base) {
    return { stem: base, ownerAgentId };
  }
  return null;
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
