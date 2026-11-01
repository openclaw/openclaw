import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { listProjectedSessions } from "./session-utils-list.js";

type ListParams = Parameters<typeof listProjectedSessions>[0];
export function listRows(
  projection: ListParams["projection"],
  opts: ListParams["opts"] = {},
  options: Omit<ListParams, "projection" | "opts"> = {},
) {
  return listProjectedSessions({ projection, opts, ...options });
}

export function writeRow(key: string, entry: Partial<SessionEntry> = {}, agentId = "main") {
  return replaceSessionEntrySync(
    { agentId, sessionKey: key },
    { sessionId: key, updatedAt: 1, ...entry },
  );
}
