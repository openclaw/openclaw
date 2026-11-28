import type { SessionMember } from "./session-membership-facts.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { SessionEntry } from "./types.js";

export type SessionSharingExpectedEntry = Pick<
  SessionEntry,
  "sessionId" | "createdActor" | "visibility" | "incognito"
>;

/** Only the authenticated human-input owner prepares this effect; transcript metadata is not authority. */
export type SessionMentionInvitation = {
  addedBy: string;
  expectedEntry: SessionSharingExpectedEntry;
  profiles: readonly {
    profileId: string;
    aliases: readonly string[];
    tokens: readonly string[];
    access?: SessionMember["access"];
  }[];
};

export type PreparedSessionMentionInvitation = {
  invitation: SessionMentionInvitation;
  assertCurrent: () => void;
};

export type SessionMentionInvitationCommit = {
  message: unknown;
  invitations: readonly SessionMentionInvitation[];
  source: Pick<TranscriptEntryAnchor, "generation" | "rawSeq">;
};
