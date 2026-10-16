import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentMainSessionKey } from "@openclaw/session-url-contract";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

// Pins are sidebar-root facts; promotion does not change execution lineage.
// Durable dashboard sessions auto-parent to the agent main root for flow-up
// notices and sidebar threads; that lineage does not make them nested children.
export function isPinnableSessionEntry(
  storeKey: string,
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey" | "sidebarRoot"> | undefined,
): boolean {
  if (isSubagentSessionKey(storeKey)) {
    return false;
  }
  if (entry?.sidebarRoot === true) {
    return true;
  }
  if (normalizeOptionalString(entry?.spawnedBy)) {
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
