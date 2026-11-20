import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  PARTICIPATION_TOOL_ALLOWLIST,
  type ParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { intersectSessionPermissionModes } from "../agents/session-permission-exec-mode.js";
import { requiresSessionParticipation } from "./method-scopes.js";
import { readQueuedParticipationProfile } from "./queued-chat-input-admission.js";
import { resolveAuthenticatedPersonalGatewayProfileId } from "./server-methods/gateway-personal-caller.js";
import { retainSessionParticipation } from "./session-participation-lifetime.js";
import type {
  AuthorizedSessionMutationTarget,
  SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import { hiddenSessionNotFound, type SessionSharingTarget } from "./session-sharing-policy.js";
import type { createSessionSharingConsumption } from "./session-sharing-read.js";

/** The exact target owns the invitation alternative and its permanent revocation signal. */
export function createSessionParticipationAuthorization(
  params: SessionMutationAuthorizationParams,
) {
  // Later run assertions can execute inside a tool-caller context; keep the admitted person.
  const personalProfileId = resolveAuthenticatedPersonalGatewayProfileId(params.client);
  let ceiling: ParticipationCeiling | undefined;
  let lifetime: ReturnType<typeof retainSessionParticipation> | undefined;
  return {
    get ceiling() {
      return ceiling;
    },
    get signal() {
      return lifetime?.signal;
    },
    release: () => lifetime?.release(),
    followIncarnation: (previous: string | null, current: string) =>
      lifetime?.followIncarnation(previous, current),
    retain: (target: AuthorizedSessionMutationTarget | undefined) => {
      if (ceiling && target?.resolved && target.sessionId) {
        lifetime = retainSessionParticipation({
          profileId: ceiling.profileId,
          agentId: target.resolved.agentId,
          sessionKey: target.resolved.canonicalKey,
          sessionId: target.sessionId,
        });
      }
    },
    authorize: ({
      targetRef,
      target,
      policy,
      error,
    }: {
      targetRef: { sessionKey: string };
      target: SessionSharingTarget | null;
      policy: ReturnType<ReturnType<typeof createSessionSharingConsumption>["policy"]>;
      error: ErrorShape | null;
    }): { error: ErrorShape | null } | undefined => {
      const access = target && policy?.accessForTarget(target);
      const permitsMethod =
        params.method === "session.suggestions.add"
          ? access?.canSuggest
          : access?.access === "send";
      const boundedMethod = requiresSessionParticipation(
        params.method,
        params.client?.connect.scopes ?? [],
        params.requestParams,
      );
      if (
        !params.participationRequired &&
        !(permitsMethod && access?.invitedAccessCeiling && boundedMethod)
      ) {
        return undefined;
      }
      if (error) {
        return { error };
      }
      const profileId =
        personalProfileId ??
        (params.method === "chat.send"
          ? readQueuedParticipationProfile(params.requestParams)
          : undefined) ??
        (params.assertPrincipalTargetCurrent ? policy?.identity?.id : undefined);
      if (
        !target?.entry.sessionId ||
        !profileId ||
        !access?.invitedAccessCeiling ||
        !permitsMethod
      ) {
        return { error: hiddenSessionNotFound(targetRef.sessionKey) };
      }
      if (!boundedMethod) {
        return {
          error: errorShape(ErrorCodes.FORBIDDEN, "Participation does not authorize this method."),
        };
      }
      if (params.method === "session.suggestions.add") {
        return { error: null };
      }
      ceiling = {
        kind: "send",
        profileId,
        sessionKey: target.canonicalKey,
        tools: [...(policy?.invitedTools ?? PARTICIPATION_TOOL_ALLOWLIST)],
        permission: intersectSessionPermissionModes(
          policy?.invitedPermission ?? "workspace",
          target.entry.permissionMode ?? "full",
        ),
      };
      return { error: null };
    },
  };
}
