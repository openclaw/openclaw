import { getRuntimeConfig } from "../../config/config.js";
import { resolveGatewayOperatorRoleActor } from "../../gateway/operator-role-policy.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-dispatch.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { assertionSucceeds } from "../../shared/assertion.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import { captureRequesterFollowupAuthority } from "../subagents/requester-cron-authority.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

class FollowupAccessChangedError extends Error {}

/** Prepare current facts through their worker owner; no stored identity becomes authority. */
export async function prepareSessionsSendFollowup(params: {
  runId: string;
  requesterTurnRunId?: string;
  withRequesterAuthority?: <T>(run: () => T) => T;
  requesterAgentId: string;
  requesterSessionKey: string;
  targetAgentId: string;
  targetSessionKey: string;
}): Promise<FollowupRequest | undefined> {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return undefined;
  }
  if (
    caller.agentId !== params.requesterAgentId ||
    caller.sessionKey !== params.requesterSessionKey
  ) {
    throw new Error("Followup result requester differs from its admitted tool caller.");
  }
  const captured = await captureOperatorToolGatewayContinuationContext(undefined, {
    retainRequester: true,
  });
  if (!captured) {
    throw new Error("Followup completion requires in-process caller custody.");
  }
  const facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>>[] = [];
  const signal = captured.signal;
  let released = false;
  let observationReleased = false;
  let authorityReleased = true;
  let requesterAuthority: ReturnType<typeof captureRequesterFollowupAuthority>;
  const releaseResources = () => {
    if (released || !observationReleased || !authorityReleased) {
      return;
    }
    released = true;
    for (const read of facts) {
      read.release();
    }
    captured.release();
  };
  const release = () => {
    if (observationReleased) {
      return;
    }
    observationReleased = true;
    requesterAuthority?.release();
    releaseResources();
  };
  try {
    const cfg = getRuntimeConfig();
    const client = captured.run(() => getPluginRuntimeGatewayRequestScope()?.client);
    const actor = resolveGatewayOperatorRoleActor(client ?? null);
    if (!client || !actor) {
      throw new Error("Followup has no retained original caller policy.");
    }
    const policyClient = {
      ...client,
      connect: { ...client.connect, scopes: [...(client.connect.scopes ?? [])] },
      internal: { ...client.internal, operatorRoleActor: { ...actor } },
    };
    const profile =
      actor.kind === "operator"
        ? await prepareUserProfileRoleAuthority(actor.profileId)
        : undefined;
    if (actor.kind === "operator" && (!profile || profile.profileId !== actor.profileId)) {
      throw new FollowupAccessChangedError("Followup requester profile is unavailable.");
    }
    for (const target of [
      {
        agentId: params.requesterAgentId,
        sessionKey: params.requesterSessionKey,
        followLifecycle: true,
      },
      { agentId: params.targetAgentId, sessionKey: params.targetSessionKey },
    ]) {
      facts.push(await prepareSessionMutationFacts({ cfg, ...target }));
      captured.assertCurrent();
    }
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (released) {
        throw new Error("Followup completion custody was released.");
      }
      captured.assertCurrent();
      // The prepared reader owns canonical routing, physical store and incarnation fencing.
      for (const read of facts) {
        const current = read.readCurrent(getRuntimeConfig()).target;
        if (!current?.entry || current.entry.archivedAt !== undefined) {
          throw new FollowupAccessChangedError("Followup conversation changed.");
        }
      }
    };
    const admitTargets = () => {
      const currentConfig = getRuntimeConfig();
      for (const read of facts) {
        const currentFacts = read.readCurrent(currentConfig);
        const denied = authorizePreparedSessionMutation(
          {
            cfg: currentConfig,
            client: policyClient,
            sessionKey: read.storageTarget.canonicalKey,
            agentId: read.storageTarget.agentId,
          },
          currentFacts,
          {
            // The role the sending turn was admitted with; a role change applies to its next turn.
            policy:
              actor.kind === "system"
                ? undefined
                : client.internal?.operatorRunAuthority?.readCurrentRoleFacts?.().policy,
            aliases: new Set(profile?.aliases ?? []),
          },
        );
        if (denied) {
          throw new FollowupAccessChangedError("Followup session access was revoked.");
        }
      }
    };
    admitTargets();
    assertCurrent();
    const requesterSessionId = facts[0]!.readCurrent(getRuntimeConfig()).target.entry.sessionId;
    if (params.requesterTurnRunId && params.withRequesterAuthority) {
      const requesterTurnRunId = params.requesterTurnRunId;
      requesterAuthority = params.withRequesterAuthority(() =>
        captureRequesterFollowupAuthority({
          requesterTurnRunId,
          requesterAgentId: params.requesterAgentId,
          requesterSessionKey: params.requesterSessionKey,
          requesterSessionId,
          sourceSessionKey: params.targetSessionKey,
          release: () => {
            authorityReleased = true;
            releaseResources();
          },
          isCurrent: () => assertionSucceeds(assertCurrent),
        }),
      );
      // The observer and the admitted parent share the prepared custody. Either
      // can finish first; release its readers only after both owners are done.
      authorityReleased = requesterAuthority === undefined;
    }
    return {
      runId: params.runId,
      requesterSessionKey: params.requesterSessionKey,
      requesterSessionId,
      requesterAuthority,
      requesterAgentId: params.requesterAgentId,
      targetSessionKey: params.targetSessionKey,
      targetAgentId: params.targetAgentId,
      custody: {
        signal,
        assertCurrent,
        release,
        run<T>(work: () => T): T {
          assertCurrent();
          return captured.run(work);
        },
        runWithRequester<T>(work: () => Promise<T>): Promise<T> {
          assertCurrent();
          return captured.requesterOrigin
            ? captured.runWithRequester(work, params.requesterAgentId)
            : captured.run(work);
        },
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
