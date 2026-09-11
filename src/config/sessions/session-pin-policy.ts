import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

// Pins are root-session facts, except for user-facing dashboard sessions.
export function isPinnableSessionEntry(
  storeKey: string,
  entry: Pick<SessionEntry, "boardFace" | "spawnedBy" | "parentSessionKey"> | undefined,
): boolean {
  const isDashboardSession = entry?.boardFace === "dashboard";
  return (
    !isSubagentSessionKey(storeKey) &&
    (isDashboardSession ||
      (!normalizeOptionalString(entry?.spawnedBy) &&
        !normalizeOptionalString(entry?.parentSessionKey)))
  );
}
