import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionEntry } from "./types.js";

export type SessionMember = {
  identityId: string;
  addedBy: string;
  addedAt: number;
};

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

export type SessionParticipantRecord = {
  identity: SessionParticipantIdentity;
  contributionCount: number;
  firstPromptedAt: number | null;
  lastPromptedAt: number | null;
};
