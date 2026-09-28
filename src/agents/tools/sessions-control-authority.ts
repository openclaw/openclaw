import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOperatorRolePolicyForAssignment } from "../../gateway/operator-role-policy.js";
import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { ToolAuthorizationError } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

function captureSessionControlAuthority(prepared?: AdmittedRunOperatorAuthority) {
  const invocation = readOperatorToolGatewayAuthority();
  const caller = getGatewayToolCallerIdentity()?.operatorAuthority;
  const scope = getPluginRuntimeGatewayRequestScope();
  const retained = scope?.client?.internal?.operatorRunAuthority;
  const authority = prepared ?? caller ?? invocation?.operatorRunAuthority ?? retained;
  if (!authority) {
    return undefined;
  }
  const sources = [
    ...new Set([authority, caller, invocation?.operatorRunAuthority, retained]),
  ].filter((source): source is AdmittedRunOperatorAuthority => source !== undefined);
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const assertCurrent = () => {
    for (const source of sources) {
      assertAdmittedRunOperatorAuthority(source);
      source.assertCurrent();
      if (source.source !== authority.source) {
        throw new Error("Session control operator source changed.");
      }
    }
    assertCallerCurrent?.("sessions.patch");
    invocation?.signal.throwIfAborted();
    invocation?.assertCurrent?.();
    if (retained && scope?.hasCurrentClientAuthority?.() === false) {
      throw new Error("Session control caller authority is no longer active.");
    }
  };
  assertCurrent();
  return {
    authority,
    assertCurrent,
    allows: (requested: string) =>
      sources.every((source) => operatorScopeSatisfied(requested, source.scopes)) &&
      (!invocation || operatorScopeSatisfied(requested, invocation.scopes)) &&
      (!retained || operatorScopeSatisfied(requested, scope?.client?.connect.scopes ?? [])),
  };
}

/** Resolve the original host-issued source without upgrading an insufficient scope. */
export function readSessionControlAuthority(
  prepared?: AdmittedRunOperatorAuthority,
): AdmittedRunOperatorAuthority | undefined {
  return captureSessionControlAuthority(prepared)?.authority;
}

/** Availability only; the target guard and underlying Gateway policy still apply. */
export function hasSessionControlAuthority(prepared?: AdmittedRunOperatorAuthority): boolean {
  return captureSessionControlAuthority(prepared)?.allows("operator.write") ?? false;
}

/** Bind one target incarnation; this never grants the caller Gateway access. */
export async function prepareSessionControlTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string | null;
  authority?: AdmittedRunOperatorAuthority;
}): Promise<{
  sessionId: string;
  lifecycleRevision: string | null;
  assertCurrent(): void;
  release(): void;
}> {
  // Identity-only callers compose their own invocation guard. In particular, accepted
  // continuations must acquire fresh authority instead of retaining a completed tool.
  const source = params.authority ? captureSessionControlAuthority(params.authority) : undefined;
  const gateway = getInProcessGatewayToolContext();
  const currentConfig = () =>
    gateway ? (gateway.getCommittedRuntimeConfig ?? gateway.getRuntimeConfig)() : params.cfg;
  const assertSourceCurrent = () => {
    if (gateway && getInProcessGatewayToolContext() !== gateway) {
      throw new ToolAuthorizationError("Session control Gateway instance changed.");
    }
    source?.assertCurrent();
    if (source && !source.allows("operator.write")) {
      throw new ToolAuthorizationError("Session controls require operator.write.");
    }
  };
  assertSourceCurrent();
  const facts = await prepareSessionMutationFacts({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  let unsubscribe: (() => void) | undefined;
  const release = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    facts.release();
  };
  try {
    assertSourceCurrent();
    const original = facts.readCurrent(currentConfig()).target.entry;
    const sessionId = original.sessionId;
    const lifecycleRevision = original.lifecycleRevision ?? null;
    if (
      (params.expectedSessionId !== undefined && params.expectedSessionId !== sessionId) ||
      (params.expectedLifecycleRevision !== undefined &&
        params.expectedLifecycleRevision !== lifecycleRevision)
    ) {
      throw new Error("Session control target changed; retry the request.");
    }
    const profile = source
      ? await prepareUserProfileRoleAuthority(source.authority.profileId)
      : undefined;
    const profileIds = new Set(profile ? [profile.profileId, ...profile.aliases] : []);
    const assertCurrent = () => {
      assertSourceCurrent();
      const cfg = currentConfig();
      const currentFacts = facts.readCurrent(cfg);
      const current = currentFacts.target.entry;
      if (
        current.sessionId !== sessionId ||
        (current.lifecycleRevision ?? null) !== lifecycleRevision
      ) {
        throw new Error("Session control target changed; retry the request.");
      }
      if (!source) {
        return;
      }
      if (!profile || profile.profileId !== source.authority.profileId || !profile.isCurrent()) {
        throw new ToolAuthorizationError(
          "Session controls require a current authenticated profile.",
        );
      }
      // Direct active-run steering has no RPC writer to repeat session sharing policy.
      // Use the same prepared-facts decision as Gateway mutations, never assignment as access.
      const denied = authorizePreparedSessionMutation(
        {
          cfg,
          agentId: facts.storageTarget.agentId,
          sessionKey: facts.storageTarget.canonicalKey,
          client: createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "operator", profileId: source.authority.profileId },
            operatorRunAuthority: source.authority,
            scopes: [source.allows("operator.admin") ? "operator.admin" : "operator.write"],
          }),
        },
        currentFacts,
        {
          policy: resolveOperatorRolePolicyForAssignment(profile.profileId, profile.role, cfg),
          aliases: new Set(profile.aliases),
        },
      );
      if (denied) {
        throw new ToolAuthorizationError("Session control access was revoked or denied.");
      }
      if (source.allows("operator.admin")) {
        return;
      }
      const creatorId = sessionCreatorProfileId(current.createdActor);
      const assigneeId = current.owner?.actor.type === "human" ? current.owner.actor.id : undefined;
      if (
        !(creatorId && profileIds.has(creatorId)) &&
        !(assigneeId && profileIds.has(assigneeId))
      ) {
        throw new ToolAuthorizationError(
          "Session controls require the session creator or assigned human owner.",
        );
      }
    };
    assertCurrent();
    // Consume committed owner publications even when no action is executing. A later
    // reassignment must not revive a capture that lost its original target authority.
    unsubscribe = sessionChanges.subscribeFacts((change) => {
      if (
        "sessionKey" in change &&
        ![params.sessionKey, facts.storageTarget.canonicalKey].includes(change.sessionKey)
      ) {
        return;
      }
      try {
        assertCurrent();
      } catch {
        release();
      }
    });
    return { sessionId, lifecycleRevision, assertCurrent, release };
  } catch (error) {
    release();
    throw error;
  }
}
