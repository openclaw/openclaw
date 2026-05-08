import { resolveAgentIdFromSessionKey } from "../../config/sessions/main-session.js";
import { getSessionEntry, upsertSessionEntry } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyAbortCutoffToSessionEntry, hasAbortCutoff } from "./abort-cutoff.js";

export async function clearAbortCutoffInSessionRuntime(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
}): Promise<boolean> {
  const { sessionEntry, sessionStore, sessionKey } = params;
  if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
    return false;
  }

  applyAbortCutoffToSessionEntry(sessionEntry, undefined);
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;

  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const existing = getSessionEntry({ agentId, sessionKey }) ?? sessionEntry;
  applyAbortCutoffToSessionEntry(existing, undefined);
  existing.updatedAt = Date.now();
  upsertSessionEntry({
    agentId,
    sessionKey,
    entry: existing,
  });

  return true;
}
