import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "../../gateway/operator-role-policy.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-dispatch.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-state.js";
import { withFollowupRequest } from "../../tasks/task-followup-completion.js";
import type { FollowupRequest } from "../../tasks/task-followup-completion.types.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
import { startSessionsSendAgentRun } from "./sessions-send-tool.delivery.js";
import { jsonResult } from "./tool-results.js";

class FollowupAccessChangedError extends Error {}

/** Prepare current facts through their worker owner; no stored identity becomes authority. */
export async function prepareSessionsSendFollowup(params: {
  runId: string;
  requesterAgentId: string;
  requesterSessionKey: string;
  targetAgentId: string;
  targetSessionKey: string;
}): Promise<FollowupRequest | undefined> {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return undefined;
  }
  const assertInvocation = captureGatewayToolCallerAssertion();
  assertInvocation?.();
  if (
    caller.agentId !== params.requesterAgentId ||
    caller.sessionKey !== params.requesterSessionKey
  ) {
    throw new Error("Followup result requester differs from its admitted tool caller.");
  }
  // Registered runtimes keep their shipped run-scoped followup contract. Select
  // that path before preparing core custody; an admitted core request never downgrades.
  if (getRegisteredDetachedTaskLifecycleRuntime()) {
    return undefined;
  }
  const captured = await captureOperatorToolGatewayContinuationContext();
  if (!captured) {
    throw new Error("Followup completion requires in-process caller custody.");
  }
  const facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>>[] = [];
  const revoked = new AbortController();
  const signal = AbortSignal.any([captured.signal, revoked.signal]);
  let stopAccessWatch: (() => void) | undefined;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    stopAccessWatch?.();
    for (const read of facts) {
      read.release();
    }
    captured.release();
  };
  try {
    assertInvocation?.();
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
    assertInvocation?.();
    for (const target of [
      { agentId: params.requesterAgentId, sessionKey: params.requesterSessionKey },
      { agentId: params.targetAgentId, sessionKey: params.targetSessionKey },
    ]) {
      facts.push(await prepareSessionMutationFacts({ cfg, ...target }));
      assertInvocation?.();
      captured.assertCurrent();
    }
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (released) {
        throw new Error("Followup completion custody was released.");
      }
      captured.assertCurrent();
      if (profile && !profile.isCurrent()) {
        throw new FollowupAccessChangedError("Followup requester identity changed.");
      }
      const currentConfig = getRuntimeConfig();
      // The prepared reader owns canonical routing, physical store and incarnation fencing.
      for (const read of facts) {
        const currentFacts = read.readCurrent(currentConfig);
        const current = currentFacts.target;
        if (!current?.entry || current.entry.archivedAt !== undefined) {
          throw new FollowupAccessChangedError("Followup conversation was archived.");
        }
        const denied = authorizePreparedSessionMutation(
          {
            cfg: currentConfig,
            client: policyClient,
            sessionKey: read.storageTarget.canonicalKey,
            agentId: read.storageTarget.agentId,
          },
          currentFacts,
          {
            policy:
              actor.kind === "system"
                ? undefined
                : resolveOperatorRolePolicyForAssignment(
                    actor.profileId,
                    profile?.role ?? null,
                    currentConfig,
                  ),
            aliases: new Set(profile?.aliases ?? []),
          },
        );
        if (denied) {
          throw new FollowupAccessChangedError("Followup session access was revoked.");
        }
      }
    };
    assertCurrent();
    const watchedKeys = new Set(
      facts.flatMap((read) => {
        const target = read.readCurrent(cfg).target;
        return [target.canonicalKey, target.storeKey, ...target.storeKeys];
      }),
    );
    stopAccessWatch = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && !watchedKeys.has(change.sessionKey)) {
        return;
      }
      try {
        assertCurrent();
      } catch (error) {
        // Pending metadata remains fenced. A committed denial is irreversible for this capture.
        if (error instanceof FollowupAccessChangedError) {
          revoked.abort(error);
        }
      }
    });
    return {
      runId: params.runId,
      requesterSessionKey: params.requesterSessionKey,
      requesterSessionId: facts[0]!.readCurrent(getRuntimeConfig()).target.entry.sessionId,
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
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Reconcile only the original admission; an uncertain ACK never starts a replacement. */
export async function startSessionsSendFollowup(
  request: FollowupRequest | undefined,
  params: Parameters<typeof startSessionsSendAgentRun>[0],
  replyContext: Omit<
    Parameters<typeof startSessionsSendReplyFlow>[0],
    "runId" | "skip" | "completion" | "reply"
  >,
) {
  const dispatch = () => startSessionsSendAgentRun(params);
  const start = request ? await withFollowupRequest(request, dispatch) : await dispatch();
  const completion = request?.completion;
  if (!start.ok) {
    if (completion?.accepted && request) {
      // The live owner proves acceptance even when its transport ACK was lost.
      // Preserve that one result obligation; never dispatch another target run.
      startSessionsSendReplyFlow({
        ...replyContext,
        runId: request.runId,
        completion,
        skip: false,
        targetSessionKey: request.targetSessionKey,
        targetAgentId: request.targetAgentId,
        requesterAgentId: request.requesterAgentId,
        requesterSessionKey: request.requesterSessionKey,
        maxPingPongTurns: 0,
        replyMode: "one-way",
        notifyRequesterOnWaitFailure: true,
      });
      return {
        start: {
          ...start,
          result: jsonResult({
            ...(isRecord(start.result.details) ? start.result.details : {}),
            sentBeforeError: true,
          }),
        },
        completion,
      };
    }
    completion?.close();
    if (!completion) {
      request?.custody.release();
    }
    return { start, completion };
  }
  if (request && !completion) {
    request.custody.release();
    throw new Error("Gateway did not retain followup result custody; inspect the accepted run.");
  }
  return { start, completion };
}
