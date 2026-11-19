import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/** Missing transcript cleanup cannot retire protected or still-initializing sessions. */
export function shouldPreserveSessionCleanupEntry(
  sessionKey: string,
  entry: SessionEntry,
): boolean {
  if (
    (entry.modelSelectionLocked === true || entry.archivedAt !== undefined) &&
    shouldPreserveMaintenanceEntry({ key: sessionKey, entry })
  ) {
    return true;
  }
  const legacySessionFile = readStringField(asOptionalRecord(entry), "sessionFile");
  return Boolean(
    parseAgentSessionKey(sessionKey) &&
    (entry.initializationPending === true ||
      (entry.sessionId === sessionKey && !legacySessionFile?.trim())),
  );
}
