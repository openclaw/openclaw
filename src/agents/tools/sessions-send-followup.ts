import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { registerSessionStateWatch } from "../../sessions/session-state-events.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  type AcceptedSessionSpawn,
} from "../accepted-session-spawn.js";
import { withFollowupRequest } from "../subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../subagents/registry/subagent-registry-read.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  prepareGatewayToolCallerAssertion,
} from "./gateway-caller-context.js";
import {
  getInProcessGatewayToolContext,
  runWithGatewayToolCleanupContext,
} from "./in-process-gateway.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
import {
  startSessionsSendAgentRun,
  trySessionsSendActiveRunDelivery,
} from "./sessions-send-tool.delivery.js";
import type { AgentStepSession } from "./sessions-send-tool.types.js";
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
        replyMode: replyContext.replyMode === "peer" ? "peer" : "one-way",
        notifyRequesterOnWaitFailure: true,
      });
      return {
        start: {
          ...start,
          selfHeld: undefined,
          result: jsonResult({
            ...start.result.details,
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

/** Eligible followups retain their accepted result through the existing completion owner. */
export async function dispatchSessionsSendFollowup(
  params: Parameters<typeof startSessionsSendAgentRun>[0],
  replyContext: Parameters<typeof startSessionsSendFollowup>[2],
  options: {
    message: string;
    ownChild: boolean;
    persistentChildAccess?: boolean;
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
  const isCronRequester = isCronRunSessionKey(options.requesterSessionKey);
  const requesterTurn =
    (!params.expectedSessionId || options.persistentChildAccess) &&
    options.nativeChild &&
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
  const registryTurn =
    (!isCronRequester && options.watch) || (options.ownChild && !("ok" in active))
      ? requesterTurn
      : undefined;
  const completionTurn = isCronRequester ? undefined : registryTurn;
  // A queued self-send has no separate recipient to observe it with operator.write.
  // Keep the original run's result, without registering the session as its own child.
  const ownSessionCompletion =
    replyContext.replyMode === "peer" &&
    options.requesterSessionKey === params.sessionStoreTarget.canonicalKey &&
    options.requesterAgentId === params.sendParams.agentId &&
    getInProcessGatewayToolContext()?.lifecycleRuntime !== undefined;
  const request =
    !("ok" in active) &&
    (registryTurn ||
      ownSessionCompletion ||
      (replyContext.replyMode === "one-way" && options.ownChild)) &&
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
          registryTurn ? undefined : request,
          {
            ...params,
            ...active,
            ...(registryTurn
              ? {
                  retainAcceptance: true,
                  assertDispatchCurrent: () => {
                    if (!admissionOpen) {
                      throw new Error("Child followup admission was closed.");
                    }
                    assertCurrent();
                    params.assertDispatchCurrent?.();
                  },
                }
              : {}),
          },
          replyContext,
        );
  try {
    if (start.ok && registryTurn) {
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
              requesterTurnRunId: registryTurn,
              requesterRunInstance: instance,
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
              requesterTurnRunId: registryTurn,
              requesterOrigin: replyContext.requesterOrigin,
              task: options.message,
              cleanup: "keep",
              spawnMode: "session",
              expectsCompletionMessage: Boolean(completionTurn),
              completionTarget: completionTurn ? "parent" : undefined,
              completionRequesterSessionId: replyContext.requesterSession?.sessionId,
              completionRequesterLifecycleRevision:
                replyContext.requesterSession?.lifecycleRevision,
            },
            {
              assertCurrent: assertCompletionCurrent,
              assertPublicationCurrent: () => request?.custody.assertCurrent(),
              acceptedRunReplay: true,
              requesterRunInstance: instance,
            },
          );
          accepted = {
            runId: start.runId,
            childSessionKey,
            expectsCompletionMessage: Boolean(completionTurn),
          };
        }
        if (completionTurn && request?.requesterAuthority) {
          const runId = start.targetDisposition === "steered" ? start.steeredRunId : start.runId;
          const entry = runId ? subagentRuns.get(runId) : undefined;
          if (!entry) {
            throw new Error("Accepted child followup has no registry owner.");
          }
          request.requesterAuthority.bind({ entry, runs: subagentRuns });
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
        // Only an accepted start reaches this catch, so it is never a retainable refusal.
        selfHeld: undefined,
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
    if (registryTurn) {
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
    (!params.expectedSessionId || options.persistentChildAccess) &&
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
    watchField: options.watch
      ? {
          watched,
          ...(!watched && start.ok
            ? {
                watchError:
                  "The send was accepted, but no proactive state watch was registered. Watches require distinct, valid agent-qualified session keys and current session authority. Use owner-scoped session_status changesSince to reconcile state.",
              }
            : {}),
        }
      : {},
  };
}
