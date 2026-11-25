import type { SessionEntry } from "../../config/sessions.js";

export function sendPolicySessionEntry(
  sendPolicy: "allow" | "deny",
  fields: Pick<SessionEntry, "verboseLevel"> = {},
) {
  return { sessionId: "s1", updatedAt: 0, sendPolicy, ...fields };
}

export function pendingFinalSessionEntry(
  custody: { sessionId: string; intentId: string; deliveryId: string },
  text: string,
): SessionEntry {
  return {
    sessionId: custody.sessionId,
    updatedAt: Date.now(),
    pendingFinalDelivery: {
      kind: "replayable",
      text,
      createdAt: Date.now(),
      intentId: custody.intentId,
      deliveries: [{ id: custody.deliveryId, state: "prepared" }],
    },
  };
}
