import path from "node:path";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";

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
 * Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}

export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const { base, ownerAgentId } = parseSessionsPath(hitPath);
  if (base.endsWith(".jsonl")) {
    const stem = base.slice(0, -".jsonl".length);
    return stem ? { stem, ownerAgentId } : null;
  }
  if (base.endsWith(".md")) {
    const stem = base.slice(0, -".md".length);
    return stem ? { stem } : null;
  }
  return null;
}

/**
 * Map transcript stem to canonical session store keys (all agents in the combined store).
 * Session tools visibility and agent-to-agent policy are enforced by the caller (e.g.
 * `createSessionVisibilityGuard`), including cross-agent cases.
 */
export function resolveTranscriptStemToSessionKeys(params: {
  store: Record<string, SessionEntry>;
  stem: string;
}): string[] {
  const { store } = params;
  const matches: string[] = [];

  for (const [sessionKey, entry] of Object.entries(store)) {
    const sessionFile = normalizeOptionalString(entry.sessionFile);
    if (sessionFile) {
      const base = path.basename(sessionFile);
      const fileStem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
      if (fileStem === params.stem) {
        matches.push(sessionKey);
        continue;
      }
    }
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
