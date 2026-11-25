import { intersectParticipationCeilings } from "../agents/participation-ceiling.js";
import { isSessionParticipationSourceTarget } from "../config/sessions/session-participation-source.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { readSessionDelegatedParticipation } from "./session-delegated-operator-source.js";
import { isParticipantPublicationMethod } from "./session-method-policy.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";

/** An explicit non-human assignment must not fall back to a former human creator. */
export function resolveSessionSystemTurnProfileId(
  entry: Pick<SessionEntry, "owner" | "createdActor"> | undefined,
): string | undefined {
  const actor = entry?.owner
    ? entry.owner.actor
    : entry?.createdActor?.type === "human" && entry.createdActor.source === "profile"
      ? entry.createdActor
      : undefined;
  if (actor?.type !== "human") {
    return undefined;
  }
  const profileId = actor.id?.trim();
  if (!profileId) {
    throw new Error("Session owner has no current profile identity");
  }
  return profileId;
}

/** Source admission permits the original return target and independently restricted child rows. */
export function resolveParticipantRunTarget(
  params: Pick<
    SessionMutationAuthorizationParams,
    "participantRunAuthority" | "method" | "requestParams"
  >,
  target: import("./session-sharing-policy.js").SessionSharingTarget | null,
): "source" | "child" | "publication" | undefined {
  const authority = params.participantRunAuthority;
  authority?.signal?.throwIfAborted();
  const ceiling = authority?.participationCeiling;
  if (!ceiling?.source || !target || target.agentId !== ceiling.source.agentId) {
    return undefined;
  }
  if (isSessionParticipationSourceTarget(ceiling, target)) {
    return "source";
  }
  const child = readSessionDelegatedParticipation(target.entry);
  if (child) {
    intersectParticipationCeilings(child, ceiling);
    return isParticipantPublicationMethod(params.method, params.requestParams)
      ? "publication"
      : "child";
  }
  return undefined;
}
