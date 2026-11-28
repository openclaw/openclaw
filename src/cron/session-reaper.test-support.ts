import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import "./session-reaper.js";

type CronSessionReaperTestApi = {
  resetReaperThrottle(): void;
};

function getTestApi(): CronSessionReaperTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cronSessionReaperTestApi")
  ] as CronSessionReaperTestApi;
}

export function resetReaperThrottle(): void {
  getTestApi().resetReaperThrottle();
}

export async function seedSessionEntries(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
  }
}
