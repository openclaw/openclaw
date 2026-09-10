import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentMainSessionKey, DEFAULT_MAIN_KEY } from "@openclaw/session-url-contract";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

// Pins are root-session facts; children live in their parent's tree.
// Durable dashboard sessions auto-parent to the agent main root for flow-up
// notices and sidebar threads; that lineage does not make them nested children.
export function isPinnableSessionEntry(
  storeKey: string,
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey"> | undefined,
  agentMainSessionKey?: string,
): boolean {
  if (isSubagentSessionKey(storeKey) || normalizeOptionalString(entry?.spawnedBy)) {
    return false;
  }
  const parentSessionKey = normalizeOptionalString(entry?.parentSessionKey);
  if (!parentSessionKey) {
    return true;
  }
  const resolvedRootKey = agentMainSessionKey ?? resolveDefaultAgentMainSessionKey(storeKey);
  return parentSessionKey === resolvedRootKey;
}

function resolveDefaultAgentMainSessionKey(storeKey: string): string | undefined {
  const parsed = parseAgentSessionKey(storeKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  return buildAgentMainSessionKey({ agentId: parsed.agentId, mainKey: DEFAULT_MAIN_KEY });
}
