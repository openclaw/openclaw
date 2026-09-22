import type { SessionEntry } from "./types.js";

export type SessionParticipantProjection = Pick<SessionEntry, "participants" | "participantCount">;

/** No row JSON, prompts, or transcript payloads cross the membership publication boundary. */
export type SessionMembershipFact = readonly [
  sessionKey: string,
  category: string | null,
  membership: readonly string[],
  participants: SessionParticipantProjection,
  sessionId: string | null,
];

export type SessionMembershipFacts = {
  kind: "session-membership-facts";
  identity?: string;
  birthtime?: string;
  facts: SessionMembershipFact[];
};
