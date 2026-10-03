/** Runtime-only dispatch dependencies shared by config-driven reply delivery. */
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
export { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
export { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";

export function loadSessionStoreEntry(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  readConsistency?: "latest";
  clone?: boolean;
}): SessionEntry | undefined {
  return loadSessionEntryReadOnly(params);
}
