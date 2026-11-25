import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";

export function profileActor(id: string) {
  return { type: "human" as const, source: "profile" as const, id };
}

export function writeListEntry(key: string, entry: Parameters<typeof replaceSessionEntrySync>[1]) {
  replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
}
