import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-row-key.js";
import { getLogger } from "../../logging/logger.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { deleteSessionEntry, listSessionEntries } from "./store.js";

/** Purge session rows for a deleted agent (#65524). Best-effort. */
export async function purgeAgentSessionRows(cfg: OpenClawConfig, agentId: string): Promise<void> {
  try {
    const normalizedAgentId = normalizeAgentId(agentId);
    for (const row of listSessionEntries({ agentId: normalizedAgentId })) {
      if (
        resolveStoredSessionOwnerAgentId({
          cfg,
          agentId: normalizedAgentId,
          sessionKey: row.sessionKey,
        }) === normalizedAgentId
      ) {
        deleteSessionEntry({ agentId: normalizedAgentId, sessionKey: row.sessionKey });
      }
    }
  } catch (err) {
    getLogger().debug("session row purge skipped during agent delete", err);
  }
}
