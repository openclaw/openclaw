import { expectDefined } from "@openclaw/normalization-core";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

export function writeResidentEntries(store: Record<string, SessionEntry>, updatedAtDelta = 0) {
  for (const [sessionKey, entry] of Object.entries(store)) {
    replaceSessionEntrySync(
      {
        agentId: expectDefined(parseAgentSessionKey(sessionKey), "qualified fixture key").agentId,
        sessionKey,
      },
      { ...entry, updatedAt: entry.updatedAt + updatedAtDelta },
    );
  }
}
