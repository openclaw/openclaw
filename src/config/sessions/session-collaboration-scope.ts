import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";

export type SessionCollaborationScope = SessionAccessScope & {
  /** Captured by the activation owner; production routing remains host-owned. */
  incognito?: { actor: IncognitoSessionActor; authority: IncognitoSessionAuthority };
};
