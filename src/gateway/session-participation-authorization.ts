import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  DEFAULT_PARTICIPATION_TOOLS,
  participationPermission,
  type BoundParticipationCeiling,
  participationAllowsTool,
  type ParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { intersectSessionPermissionModes } from "../agents/session-permission-mode.js";
import { captureSessionParticipationSource } from "../config/sessions/session-participation-source.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readParticipantPublicationAuthority } from "./github-publication-participation.js";
import { requiresSessionParticipation } from "./method-scopes.js";
import { resolveAuthenticatedPersonalGatewayProfileId } from "./server-methods/gateway-personal-caller.js";
import { isParticipantPublicationMethod } from "./session-method-policy.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";
import { hiddenSessionNotFound, type SessionSharingTarget } from "./session-sharing-policy.js";
import type { createSessionSharingConsumption } from "./session-sharing-read.js";

/** The exact target owns the invitation alternative, fixed when the request is admitted. */
export function createSessionParticipationAuthorization(
  params: SessionMutationAuthorizationParams,
) {
  // Later run assertions can execute inside a tool-caller context; keep the admitted person.
  const personalProfileId = resolveAuthenticatedPersonalGatewayProfileId(params.client);
  const isBoundedMethod = () =>
    requiresSessionParticipation(
      params.method,
      params.client?.connect.scopes ?? [],
      params.requestParams,
    );
  let ceiling: ParticipationCeiling | undefined;
  return {
    isBoundedMethod,
    get admission() {
      return ceiling ? { participationCeiling: ceiling } : {};
    },
    get ceiling() {
      return ceiling;
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
      const boundedMethod = isBoundedMethod();
      if (
        !params.participationRequired &&
        !(permitsMethod && access?.invitedAccessCeiling && boundedMethod)
      ) {
        return undefined;
      }
      if (error) {
        // Refused participation reports a missing session, so the run error cannot reveal one.
        return {
          error:
            access?.invitedAccessCeiling && permitsMethod
              ? error
              : hiddenSessionNotFound(targetRef.sessionKey),
        };
      }
      const profileId =
        personalProfileId ??
        readParticipantPublicationAuthority(params.method, params.requestParams)?.profileId ??
        (params.client?.internal?.operatorRunAuthority?.participationCeiling
          ? params.client.internal.operatorRunAuthority.profileId
          : undefined) ??
        (params.assertPrincipalTargetCurrent ? policy?.identity?.id : undefined);
      if (
        !target?.entry.sessionId ||
        !profileId ||
        !access?.invitedAccessCeiling ||
        !permitsMethod ||
        (isParticipantPublicationMethod(params.method, params.requestParams) &&
          !participationAllowsTool(
            {
              kind: "send",
              profileId,
              sessionKey: target.canonicalKey,
              tools: policy?.invitedTools,
            },
            "github_publish",
          ))
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
        tools: [...(policy?.invitedTools ?? DEFAULT_PARTICIPATION_TOOLS)],
        permission: intersectSessionPermissionModes(
          policy?.invitedPermission ?? "workspace",
          target.entry.permissionMode ?? "full",
        ),
      };
      return { error: null };
    },
  };
}

/** Bind after input preparation follows any legitimate initial incarnation transition. */
export function bindSessionParticipationSource(
  ceiling: ParticipationCeiling | undefined,
  readTarget: () => SessionSharingTarget | null | undefined,
  getConfig: () => OpenClawConfig,
  assertCurrent: () => void,
): BoundParticipationCeiling | undefined {
  if (!ceiling) {
    return undefined;
  }
  assertCurrent();
  let source = ceiling.source;
  if (!source) {
    const target = readTarget();
    if (!target) {
      throw new Error("Participation requires its original session incarnation and creator.");
    }
    source = captureSessionParticipationSource(
      ceiling.sessionKey,
      target,
      resolveAgentWorkspaceDir(getConfig(), target.agentId),
    );
  }
  return {
    ...ceiling,
    tools: ceiling.tools ?? DEFAULT_PARTICIPATION_TOOLS,
    permission: participationPermission(ceiling),
    source,
  };
}
