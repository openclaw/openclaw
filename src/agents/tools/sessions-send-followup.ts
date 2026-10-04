import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { registerSessionStateWatch } from "../../sessions/session-state-events.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  type AcceptedSessionSpawn,
} from "../accepted-session-spawn.js";
import { withFollowupRequest } from "../subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../subagents/registry/subagent-registry-read.js";
import type { AgentStepSession } from "./agent-step.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  prepareGatewayToolCallerAssertion,
} from "./gateway-caller-context.js";
import { runWithGatewayToolCleanupContext } from "./in-process-gateway.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
import {
  startSessionsSendAgentRun,
  trySessionsSendActiveRunDelivery,
} from "./sessions-send-tool.delivery.js";
import { jsonResult } from "./tool-results.js";

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
      await startSessionsSendReplyFlow({
        ...replyContext,
        runId: request.runId,
        completion,
        skip: false,
        targetSessionKey: request.targetSessionKey,
        targetAgentId: request.targetAgentId,
        requesterAgentId: request.requesterAgentId,
        requesterSessionKey: request.requesterSessionKey,
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
  } else if (request && !completion) {
    request.custody.release();
    throw new Error("Gateway did not retain followup result custody; inspect the accepted run.");
  }
  return { start, completion };
}

/** Accepted child followups belong to the same completion owner as spawned work. */
export async function dispatchSessionsSendFollowup(
  params: Parameters<typeof startSessionsSendAgentRun>[0],
  replyContext: Parameters<typeof startSessionsSendFollowup>[2],
  options: {
    message: string;
    ownChild: boolean;
    nativeChild: boolean;
    watch: boolean;
    requesterSessionKey: string;
    requesterAgentId: string;
    requesterTurnRunId?: string;
    targetSession?: AgentStepSession;
    withRequesterAuthority?: <T>(run: () => T) => T;
  },
) {
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const instance = getGatewayToolCallerIdentity()?.operationalRunInstance;
  const completionChild = options.watch
    ? getLatestLiveSubagentRunByChildSessionKey(
        params.sessionStoreTarget.canonicalKey,
        undefined,
        params.sessionStoreTarget.agentId,
      )
    : undefined;
  const sameRequester = replyContext.requesterSessionKey === options.requesterSessionKey;
  const requesterTurn =
    params.allowActiveRunQueueDelivery &&
    !params.expectedSessionId &&
    options.nativeChild &&
    !isCronRunSessionKey(options.requesterSessionKey) &&
    sameRequester &&
    (options.ownChild ||
      (completionChild?.requesterSessionKey === options.requesterSessionKey &&
        completionChild.requesterAgentId === options.requesterAgentId &&
        completionChild.expectsCompletionMessage === true))
      ? options.requesterTurnRunId
      : undefined;
  if (requesterTurn && !replyContext.requesterSession) {
    throw new Error("Child followup completion requires its original requester session.");
  }
  const active = await trySessionsSendActiveRunDelivery(params, options.ownChild);
  const completionTurn =
    options.watch || (options.ownChild && !("ok" in active)) ? requesterTurn : undefined;
  const request =
    !("ok" in active) &&
    (completionTurn || (replyContext.replyMode === "one-way" && options.ownChild)) &&
    sameRequester
      ? await prepareSessionsSendFollowup({
          runId: params.runId,
          requesterTurnRunId: options.requesterTurnRunId,
          withRequesterAuthority: options.withRequesterAuthority,
          requesterAgentId: options.requesterAgentId,
          requesterSessionKey: options.requesterSessionKey,
          targetAgentId: params.sendParams.agentId,
          targetSessionKey: params.sessionStoreTarget.canonicalKey,
        })
      : undefined;
  let admissionOpen = true;
  const assertCurrent = () => {
    assertCallerCurrent?.();
    request?.custody.assertCurrent();
  };
  const { start, completion } =
    "ok" in active
      ? { start: active, completion: undefined }
      : await startSessionsSendFollowup(
          completionTurn ? undefined : request,
          {
            ...params,
            ...active,
            ...(completionTurn
              ? {
                  retainAcceptance: true,
                  assertDispatchCurrent: () => {
                    if (!admissionOpen) {
                      throw new Error("Child followup admission was closed.");
                    }
                    assertCurrent();
                  },
                }
              : {}),
          },
          replyContext,
        );
  try {
    if (start.ok && completionTurn) {
      const { registerSubagentRun, adoptSubagentRunForRequesterTurn } =
        await import("../subagents/registry/subagent-registry.js");
      // Acceptance already owns the input; retained custody owns recording its result obligation.
      const assertCompletionCurrent = () =>
        request ? request.custody.assertCurrent() : assertCurrent();
      const claim = async () => {
        assertCompletionCurrent();
        const childSessionKey = start.a2aSessionKey ?? params.sessionStoreTarget.canonicalKey;
        let accepted: AcceptedSessionSpawn | undefined;
        if (start.targetDisposition === "steered") {
          const expected = start.steeredRunId
            ? getLatestLiveSubagentRunByChildSessionKey(
                childSessionKey,
                (entry) => entry.runId === start.steeredRunId,
                params.sessionStoreTarget.agentId,
              )
            : undefined;
          if (expected) {
            accepted = await adoptSubagentRunForRequesterTurn({
              expected,
              requesterSessionKey: options.requesterSessionKey,
              requesterAgentId: options.requesterAgentId,
              requesterTurnRunId: completionTurn,
              assertCurrent: assertCompletionCurrent,
            });
          }
          if (!accepted) {
            throw new Error(
              "Steering was admitted, but its completion could not be claimed. Inspect the target before retrying.",
            );
          }
        } else {
          await registerSubagentRun(
            {
              runId: start.runId,
              childSessionKey,
              sessionEntry: options.targetSession,
              childAgentId: params.sessionStoreTarget.agentId,
              requesterSessionKey: options.requesterSessionKey,
              requesterDisplayKey: options.requesterSessionKey,
              requesterAgentId: options.requesterAgentId,
              requesterTurnRunId: completionTurn,
              requesterOrigin: replyContext.requesterOrigin,
              task: options.message,
              cleanup: "keep",
              spawnMode: "session",
              expectsCompletionMessage: true,
              completionTarget: "parent",
              completionRequesterSessionId: replyContext.requesterSession?.sessionId,
              completionRequesterLifecycleRevision:
                replyContext.requesterSession?.lifecycleRevision,
            },
            {
              assertCurrent: assertCompletionCurrent,
              assertPublicationCurrent: () => request?.custody.assertCurrent(),
              acceptedRunReplay: true,
            },
          );
          accepted = { runId: start.runId, childSessionKey, expectsCompletionMessage: true };
        }
        return accepted;
      };
      const accepted = await (request ? request.custody.run(claim) : claim());
      assertCurrent();
      if (instance) {
        mergeAcceptedSessionSpawnsForRun(instance, [accepted]);
      }
    }
  } catch (error) {
    let failure = error;
    if (start.ok && completionTurn) {
      const runId = start.targetDisposition === "steered" ? start.steeredRunId : start.runId;
      if (runId && instance) {
        try {
          const { reconcileRequesterTurnClaimForRun } =
            await import("../subagents/registry/subagent-registry-requester-claim.js");
          await runWithGatewayToolCleanupContext(() =>
            reconcileRequesterTurnClaimForRun({
              runId,
              requesterSessionKey: options.requesterSessionKey,
              requesterAgentId: options.requesterAgentId,
              requesterRunInstance: instance,
            }),
          );
        } catch (reconciliationError) {
          failure = new AggregateError(
            [error, reconciliationError],
            "Accepted child completion could not be reconciled with its requester.",
          );
        }
      }
    }
    return {
      start: {
        ok: false as const,
        result: jsonResult({
          runId: start.ok ? start.runId : params.runId,
          status: "error",
          error: formatErrorMessage(failure),
          sentBeforeError: true,
          sessionKey: replyContext.displayKey,
        }),
      },
      completion,
      registryCompletion: false,
      watchField: {},
    };
  } finally {
    admissionOpen = false;
    if (completionTurn) {
      request?.custody.release();
    }
  }
  const targetSessionKey = start.ok
    ? (start.a2aSessionKey ?? params.sessionStoreTarget.canonicalKey)
    : undefined;
  let watched = false;
  if (
    start.ok &&
    options.watch &&
    !params.expectedSessionId &&
    replyContext.requesterSessionKey &&
    targetSessionKey &&
    replyContext.requesterSessionKey !== targetSessionKey
  ) {
    watched = await registerSessionStateWatch(
      {
        watcherSessionKey: replyContext.requesterSessionKey,
        targetSessionKey,
        targetAgentId: params.sendParams.agentId,
      },
      { prepareCurrent: prepareGatewayToolCallerAssertion },
    );
  }
  return {
    start,
    completion,
    registryCompletion: Boolean(start.ok && completionTurn),
    watchField: options.watch ? { watched } : {},
  };
}
