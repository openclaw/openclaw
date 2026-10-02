import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentMainSessionKey } from "@openclaw/session-url-contract";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

// Pins are root-session facts; children live in their parent's tree.
// Durable dashboard sessions auto-parent to the agent main root for flow-up
// notices and sidebar threads; that lineage does not make them nested children.
export function isPinnableSessionEntry(
  storeKey: string,
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey"> | undefined,
): boolean {
  if (isSubagentSessionKey(storeKey) || normalizeOptionalString(entry?.spawnedBy)) {
    return false;
  }
  const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
  if (!parentSessionKey) {
    return true;
  }
  const parsed = parseAgentSessionKey(storeKey);
  return (
    parsed !== null && parentSessionKey === buildAgentMainSessionKey({ agentId: parsed.agentId })
  );
}
