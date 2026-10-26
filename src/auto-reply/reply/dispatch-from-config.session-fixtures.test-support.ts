import type { SessionEntry } from "../../config/sessions.js";

export function sendPolicySessionEntry(
  sendPolicy: "allow" | "deny",
  fields: Pick<SessionEntry, "verboseLevel"> = {},
) {
  return { sessionId: "s1", updatedAt: 0, sendPolicy, ...fields };
}
