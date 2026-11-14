import type { UserTurnTranscriptAdmissionReceipt } from "../sessions/user-turn-transcript.types.js";

export function createFirstTurnContextFixture() {
  const session = { agentId: "main", sessionId: "first-turn-session" };
  const receipt: UserTurnTranscriptAdmissionReceipt = {
    ...session,
    sessionKey: "agent:main:first-turn",
    storePath: "first-turn-store",
    generation: "first-turn-generation",
    entryId: "first-turn-user",
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: "first-turn",
    role: "user",
  };
  return { session, receipt };
}
