import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

export type SessionSharingExpectedEntry = Pick<
  SessionEntry,
  "sessionId" | "createdActor" | "visibility" | "incognito"
>;
export type SessionMemberAdd = {
  identityId: string;
  addedBy: string;
  addedAt?: number;
  expectedSessionId?: string;
  expectedEntry?: SessionSharingExpectedEntry;
};
export type SessionParticipantRecordInput = {
  identity: SessionParticipantIdentity;
  promptedAt?: number;
  sessionAgentId?: string;
};
export type RecordSessionParticipantResult = "inserted" | "updated" | "capped";
export type MembershipPublication = { facts?: Extract<SessionRowFacts, { kind: "member" }> };
type ParticipantPublication = {
  projectionChanged: boolean;
  participants: Pick<SessionEntry, "participants" | "participantCount">;
};

export type SessionSharingWorkerOperations = {
  "category.prepare": { input: { scope: SessionAccessScope; from: string }; output: string[] };
  "category.apply": {
    input: { scope: SessionAccessScope; from: string; to?: string };
    output: Array<{ sessionKey: string; sessionId: string }>;
  };
  add: {
    input: { scope: SessionAccessScope; params: SessionMemberAdd };
    output: { value: { member: SessionMember; inserted: boolean } } & MembershipPublication;
  };
  remove: {
    input: {
      scope: SessionAccessScope;
      identityId: string;
      expected?: Pick<SessionMember, "addedBy" | "addedAt">;
      expectedSessionId?: string;
      expectedEntry?: SessionSharingExpectedEntry;
    };
    output: { value: SessionMember | null } & MembershipPublication;
  };
  participant: {
    input: { scope: SessionAccessScope; params: SessionParticipantRecordInput };
    output: { value: RecordSessionParticipantResult | null } & ParticipantPublication;
  };
};
