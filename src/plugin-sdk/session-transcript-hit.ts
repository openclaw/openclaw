import path from "node:path";
import { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";

// Archived transcripts live alongside active ones on disk, named
// `<stem>.jsonl.reset.<iso>` (when a session is reset / rotated) or
// `<stem>.jsonl.deleted.<iso>` (when an archived copy is retained after
// deletion). Memory search surfaces hits from these archives under the same
// `source: "sessions"` tag, so stem extraction must recognise the archive
// suffixes or the visibility guard drops every archived hit as unresolvable.
const ARCHIVED_TRANSCRIPT_SUFFIX_RE = /\.jsonl\.(?:reset|deleted)\.[^/]+$/;

/**
 * Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
 * Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
 * Archived transcripts (`.jsonl.reset.<iso>` / `.jsonl.deleted.<iso>`) resolve
 * to the same stem as the live `.jsonl` they were rotated from.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  const normalized = hitPath.replace(/\\/g, "/");
  const trimmed = normalized.startsWith("sessions/")
    ? normalized.slice("sessions/".length)
    : normalized;
  const base = path.basename(trimmed);
  const archivedMatch = ARCHIVED_TRANSCRIPT_SUFFIX_RE.exec(base);
  if (archivedMatch) {
    const stem = base.slice(0, archivedMatch.index);
    return stem || null;
  }
  if (base.endsWith(".jsonl")) {
    const stem = base.slice(0, -".jsonl".length);
    return stem || null;
  }
  if (base.endsWith(".md")) {
    const stem = base.slice(0, -".md".length);
    return stem || null;
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
  const stemAsFile = params.stem.endsWith(".jsonl") ? params.stem : `${params.stem}.jsonl`;
  const parsedStemId = parseUsageCountedSessionIdFromFileName(stemAsFile);

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
    if (entry.sessionId === params.stem || (parsedStemId && entry.sessionId === parsedStemId)) {
      matches.push(sessionKey);
    }
  }
  return [...new Set(matches)];
}
