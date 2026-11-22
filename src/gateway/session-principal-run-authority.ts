import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { intersectOperatorModelPolicy } from "../agents/operator-model-policy.js";
import {
  intersectParticipationCeilings,
  sessionParticipationCeiling,
  type ParticipationCeiling,
} from "../agents/participation-ceiling.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { isParticipantPublicationMethod } from "./session-method-policy.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";

export async function prepareSessionParticipationRun(params: {
  context: GatewayRequestContext;
  agentId: string;
  entry?: SessionEntry;
  turnCeiling?: ParticipationCeiling;
  preserveRecordedSource?: true;
  recoveredOperatorAuthority?: AdmittedRunOperatorAuthority;
  assertCurrent?: () => void;
}) {
  const ceiling = intersectParticipationCeilings(
    sessionParticipationCeiling(params.entry),
    params.turnCeiling,
  );
  if (!ceiling?.source) {
    return undefined;
  }
  if (ceiling.source.agentId !== params.agentId) {
    throw new Error("Participant children must stay with the original agent.");
  }
  return prepareSessionPrincipalRunAuthority({
    context: params.context,
    profileId: ceiling.profileId,
    participationCeiling: ceiling,
    preserveRecordedSource: params.preserveRecordedSource,
    recoveredOperatorAuthority: params.recoveredOperatorAuthority,
    agentId: ceiling.source.agentId,
    sessionKey: ceiling.sessionKey,
    sessionId: ceiling.source.sessionId,
    assertCurrent: params.assertCurrent,
  });
}

/** Admit a new input as a recorded person using only that person's current grants. */
export async function prepareSessionPrincipalRunAuthority(
  params: Parameters<
    typeof import("./session-sharing-authorization-async.js").prepareSessionPrincipalRunAccess
  >[0],
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
    if (params.participationCeiling) {
      if (!source.participationCeiling) {
        throw new Error("The original invitation no longer permits participation.");
      }
      const current = admitted.authority;
      admitted.authority = createAdmittedRunOperatorAuthority({
        ...current,
        participationCeiling: intersectParticipationCeilings(
          params.participationCeiling,
          source.participationCeiling,
        ),
        get modelPolicy() {
          return current.modelPolicy;
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
  const child = sessionParticipationCeiling(target.entry);
  if (child) {
    intersectParticipationCeilings(child, ceiling);
    return isParticipantPublicationMethod(params.method, params.requestParams)
      ? "publication"
      : "child";
  }
  return undefined;
}
