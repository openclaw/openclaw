import type { SessionCapabilityEntry, SessionCapabilityLookup } from "./subagent-session-store.js";

export function createSessionCapabilityLookup<Entry extends SessionCapabilityEntry>(
  entries: Record<string, Entry>,
): SessionCapabilityLookup {
  const entriesById = new Map<string, Entry>();
  for (const entry of Object.values(entries)) {
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      entriesById.set(entry.sessionId.trim(), entry);
    }
  }
  return {
    get: (key) => entries[key],
    getById: (id) => entriesById.get(id.trim()),
  };
}
