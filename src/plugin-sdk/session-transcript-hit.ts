import path from "node:path";
import { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

/**
 * Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
 * Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  const normalized = hitPath.replace(/\\/g, "/");
  const trimmed = normalized.startsWith("sessions/")
    ? normalized.slice("sessions/".length)
    : normalized;
  const base = path.basename(trimmed);
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
 * Map transcript stem to canonical session store keys for the given agent.
 */
export function resolveTranscriptStemToSessionKeys(params: {
  cfg: OpenClawConfig;
  agentId: string;
  stem: string;
}): string[] {
  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  const matches: string[] = [];
  const stemAsFile = params.stem.endsWith(".jsonl") ? params.stem : `${params.stem}.jsonl`;
  const parsedStemId = parseUsageCountedSessionIdFromFileName(stemAsFile);

  for (const [sessionKey, entry] of Object.entries(store)) {
    if (resolveAgentIdFromSessionKey(sessionKey) !== params.agentId) {
      continue;
    }
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
