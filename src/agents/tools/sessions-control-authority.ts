import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOperatorRolePolicyForAssignment } from "../../gateway/operator-role-policy.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { ToolAuthorizationError } from "./common.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";
import { captureSessionControlAuthority } from "./sessions-operator-authority.js";

/** Bind one target incarnation; this never grants the caller Gateway access. */
export async function prepareSessionControlTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string | null;
  operation: "archive" | "restore" | "stop";
  authority?: AdmittedRunOperatorAuthority;
}): Promise<{
  sessionId: string;
  lifecycleRevision: string | null;
  assertCurrent(this: void): void;
  release(): void;
}> {
  // Identity-only callers compose their own invocation guard. In particular, accepted
  // continuations must acquire fresh authority instead of retaining a completed tool.
  const source = params.authority ? captureSessionControlAuthority(params.authority) : undefined;
  const gateway = getInProcessGatewayToolContext();
  const currentConfig = () =>
    gateway ? (gateway.getCommittedRuntimeConfig ?? gateway.getRuntimeConfig)() : params.cfg;
  const assertSourceCurrent = composeSessionSourceAssertion(
    [source?.assertCurrent],
    (assertSource) => {
      if (gateway && getInProcessGatewayToolContext() !== gateway) {
        throw new ToolAuthorizationError("Session control Gateway instance changed.");
      }
      assertSource();
      if (source && !source.allows("operator.write")) {
        throw new ToolAuthorizationError("Session controls require operator.write.");
      }
    },
  );
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
    const assertTargetCurrent = () => {
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
          policy: resolveOperatorRolePolicyForAssignment(
            profile.profileId,
            profile.role,
            cfg,
            profile.githubLogin ?? null,
          ),
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
      // Self-archive acknowledges before the Gateway write, so reject non-creators here too.
      // Assignment permits stopping work, not changing the shared archive state.
      if (
        !(creatorId && profileIds.has(creatorId)) &&
        !(params.operation === "stop" && assigneeId && profileIds.has(assigneeId))
      ) {
        throw new ToolAuthorizationError(
          `Session ${params.operation} requires the session creator${params.operation === "stop" ? " or assigned human owner" : ""}.`,
        );
      }
    };
    const assertCurrent = composeSessionSourceAssertion([assertSourceCurrent, assertTargetCurrent]);
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
        assertTargetCurrent();
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
