import type { SessionEntry } from "../../../config/sessions.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";

export async function seedPluginSessionEntry(
  storePath: string,
  fields: Partial<SessionEntry> & Record<string, unknown> = {},
  sessionKey = "agent:main:main",
): Promise<void> {
  await replaceSessionEntry(
    { storePath, sessionKey },
    { sessionId: "session-id", updatedAt: Date.now(), ...fields },
  );
}
