import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentMainSessionKey } from "@openclaw/session-url-contract";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

// Home-parented sessions are roots; hidden lineage alone does not promote a child.
export function isSidebarRootSessionEntry(
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

export function isPinnableSessionEntry(
  storeKey: string,
  entry:
    | Pick<SessionEntry, "boardFace" | "spawnedBy" | "parentSessionKey" | "sidebarRoot">
    | undefined,
): boolean {
  return (
    isSidebarRootSessionEntry(storeKey, entry) ||
    (entry?.boardFace === "dashboard" && !isSubagentSessionKey(storeKey))
  );
}
