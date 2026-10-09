import type { SqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import type { SessionActor, SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionEntry, SessionProfileInvolvement } from "./types.js";

export type SessionCollaborationMutation = Exclude<
  keyof SessionSharingWorkerOperations,
  "category.prepare" | "category.apply" | "involvement"
>;

export type SessionSharingExpectedEntry = Pick<
  SessionEntry,
  "sessionId" | "createdActor" | "visibility" | "incognito"
>;
export type SessionMetadataExpectedEntry = SessionSharingExpectedEntry &
  Pick<SessionEntry, "lifecycleRevision">;
export type SessionOwnerAssignParams = {
  owner: SessionActor & { id: string };
  assignedBy: SessionActor & { id: string };
  assignedAt?: number;
  expectedSessionId?: string;
  expectedEntry?: SessionMetadataExpectedEntry;
};
export type StoredSessionSuggestionState = "pending" | "accepted" | "dismissed";
export type StoredSessionSuggestionResolution = "send" | "queue" | "edit" | "dismiss";
export type StoredSessionSuggestion = {
  id: string;
  authorId: string;
  authorLabel?: string;
  text: string;
  createdAt: number;
  state: StoredSessionSuggestionState;
};
export type SessionSuggestionListParams = { authorId?: string; pendingOnly?: boolean };
export type SessionSuggestionDispatchClaim =
  | { kind: "busy" }
  | { kind: "mismatch"; resolution: StoredSessionSuggestionResolution }
  | { kind: "claimed"; suggestion: StoredSessionSuggestion; token: string };
export type SessionSuggestionAddParams = {
  authorId: string;
  authorLabel?: string;
  text: string;
  createdAt?: number;
  id?: string;
  expectedSessionId?: string;
  expectedEntry?: SessionMetadataExpectedEntry;
};
export type SessionSuggestionClaimParams = {
  id: string;
  expectedSessionId?: string;
  resolution: StoredSessionSuggestionResolution;
  now?: number;
  expectedEntry?: SessionMetadataExpectedEntry;
};
export type SessionSuggestionReleaseParams = {
  id: string;
  token: string;
  expectedSessionId?: string;
};
export type SessionSuggestionFinalizeParams = SessionSuggestionReleaseParams & {
  state: Exclude<StoredSessionSuggestionState, "pending">;
  expectedEntry?: SessionMetadataExpectedEntry;
};
type OwnerPublication = { facts?: Extract<SessionRowFacts, { kind: "owner" }> };

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

export type SessionInvolvementMutation = {
  expectedSessionId: string;
  expectedEntry?: SessionMetadataExpectedEntry;
  profileIds: readonly string[];
  change:
    | { kind: "visibility"; hidden: boolean }
    | { kind: "mention"; source: NonNullable<SessionProfileInvolvement["lastMention"]> };
};

export type SessionSharingWorkerOperations = {
  involvement: {
    input: {
      scope: SessionAccessScope;
      params: SessionInvolvementMutation;
      profiles: { profileId: string; aliases: string[] }[];
    };
    output: { accepted: boolean; changed: boolean };
  };
  "owner.assign": {
    input: { scope: SessionAccessScope; params: SessionOwnerAssignParams };
    output: { value: SessionOwnerAssignment | null } & OwnerPublication;
  };
  "suggestion.add": {
    input: { scope: SessionAccessScope; params: SessionSuggestionAddParams };
    output: StoredSessionSuggestion;
  };
  "suggestion.claim": {
    input: { scope: SessionAccessScope; params: SessionSuggestionClaimParams };
    output: SessionSuggestionDispatchClaim | null;
  };
  "suggestion.release": {
    input: { scope: SessionAccessScope; params: SessionSuggestionReleaseParams };
    output: boolean;
  };
  "suggestion.finalize": {
    input: { scope: SessionAccessScope; params: SessionSuggestionFinalizeParams };
    output: StoredSessionSuggestion | null;
  };
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

export type SessionCollaborationFact = Extract<
  SessionRowFacts,
  { kind: "member" | "owner" | "participants" | "category" | "unchanged" }
>;

export type SessionSharingCommitReceipt = {
  kind: "session-collaboration-committed";
  type: Exclude<keyof SessionSharingWorkerOperations, "category.prepare">;
  result: SessionSharingWorkerOperations[Exclude<
    keyof SessionSharingWorkerOperations,
    "category.prepare"
  >]["output"];
  publication: SqliteCommitReceipt<readonly SessionCollaborationFact[]>;
};
