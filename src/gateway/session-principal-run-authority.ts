import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { intersectOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { intersectParticipationCeilings } from "../agents/participation-ceiling.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
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

/** Admit a new input as a recorded person using only that person's current grants. */
export async function prepareSessionPrincipalRunAuthority(
  params: Omit<
    Parameters<
      typeof import("./session-sharing-authorization-async.js").prepareSessionPrincipalRunAccess
    >[0],
    "participationCeiling"
  >,
): Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void }> {
  const { prepareSessionPrincipalRunAccess } =
    await import("./session-sharing-authorization-async.js");
  const source = await prepareSessionPrincipalRunAccess(params);
  let admitted: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
  try {
    admitted = await captureGatewayOperatorRunAuthority({
      client: source.client,
      context: params.context,
      sourceAuthority: source,
    });
    if (!admitted) {
      throw new Error("Session principal has no current run authority.");
    }
    const original = source.recordedOperatorAuthority;
    if (original) {
      const current = admitted.authority;
      admitted.authority = createAdmittedRunOperatorAuthority({
        ...current,
        scopes: intersectOperatorScopes(current.scopes, original.scopes),
        gatewayAccessGrant: original.gatewayAccessGrant,
        recoverySnapshot: original.recoverySnapshot,
        channelRecoverySource: original.channelRecoverySource,
        get modelPolicy() {
          return intersectOperatorModelPolicy(original.modelPolicy, current.modelPolicy);
        },
      });
    }
    return admitted;
  } catch (error) {
    if (admitted) {
      admitted.release();
    } else {
      source.release();
    }
    throw error;
  }
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
  authority?.assertCurrent();
  const ceiling = authority?.participationCeiling;
  if (!ceiling?.source || !target || target.agentId !== ceiling.source.agentId) {
    return undefined;
  }
  if (
    target.canonicalKey === ceiling.sessionKey &&
    target.entry.sessionId === ceiling.source.sessionId
  ) {
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
