import type { SessionOwnerOption } from "../session-owner.ts";

export type PersonalSessionGroupCandidate = {
  key: string;
  label: string;
  pinnable: boolean;
  archived?: boolean;
  /** Present only when someone other than the viewer owns the session. */
  ownedBy?: Pick<SessionOwnerOption, "id" | "label" | "avatarUrl" | "identity">;
};

/** Where the section editor draws its session choices from. */
export type PersonalSessionGroupScope =
  | { kind: "mine" | "involving" | "all" }
  | { kind: "project"; projectId: string };

export type PersonalSessionGroupScopeChoices = {
  /** Owner-relative scopes need a signed-in profile. */
  personal: boolean;
  projects: readonly { id: string; label: string }[];
};

export type PersonalSessionGroupPage = {
  sessions: readonly PersonalSessionGroupCandidate[];
  hasMore: boolean;
};
