import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { operatorSessionCap } from "./operator-role-policy.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { resolveSessionVisibility } from "./session-sharing-policy.js";

/** Captured disclosure inputs; the host rechecks their authority before sending a page. */
export type SessionListVisibility =
  | { kind: "all" }
  | { kind: "none" }
  | {
      kind: "profile";
      profileId: string;
      aliases: ReadonlySet<string>;
      sessionCap?: ReturnType<typeof operatorSessionCap>;
    };

export function createProfileSessionEntryFilter(
  params: { profileId: string; sessionCap?: ReturnType<typeof operatorSessionCap> },
  isCreator?: (actor: SessionEntry["createdActor"]) => boolean,
) {
  // Unprepared preview filters may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, params.profileId));
  return (
    sessionKey: string | undefined,
    entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">,
  ) =>
    entry.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    (creatorMatches(entry.createdActor) ||
      (params.sessionCap !== "none" && resolveSessionVisibility(entry) !== "draft"));
}

export function createPreparedSessionListEntryFilter(visibility: SessionListVisibility) {
  if (visibility.kind === "all") {
    return undefined;
  }
  if (visibility.kind === "none") {
    return () => false;
  }
  return createProfileSessionEntryFilter(visibility, (actor) => {
    const id = sessionCreatorProfileId(actor);
    return Boolean(id && (id === visibility.profileId || visibility.aliases.has(id)));
  });
}
