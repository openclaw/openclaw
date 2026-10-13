import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayProtocolResponseError } from "../../../packages/gateway-client/src/protocol-request.js";
import { getRuntimeConfig } from "../../config/config.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import type { GatewaySessionStoreTargetWithStore } from "../../gateway/session-utils-store.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import { isTerminalAgentWaitTimeout, waitForAgentRunReply } from "../run-wait.js";
import { resolveSubagentAnnounceTimeoutMs } from "../subagents/announce/subagent-announce-delivery-retry.js";
import type { FollowupCompletionOwner } from "../subagents/completion/session-followup-completion.types.js";
import {
  callAgentToolGatewayRequest,
  runWithGatewayToolContinuationContext,
} from "./in-process-gateway.js";
import { recordSessionToolActionFact } from "./sessions-access.js";
import { sendReplyResult } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import type { SessionsSendStart } from "./sessions-send-tool.delivery.js";
import { jsonResult } from "./tool-results.js";
const log = createSubsystemLogger("agents/sessions-send");

/** Await custody transfer before returning the tool; result observation stays detached. */
export function startSessionsSendReplyFlow(
  params: Parameters<typeof runSessionsSendA2AFlow>[0] & {
    skip: boolean;
    completion?: FollowupCompletionOwner;
  },
) {
  if (params.skip) {
    return Promise.resolve();
  }
  const { completion } = params;
  const continueOwned = async <T>(run: () => Promise<T>) =>
    completion ? completion.request.custody.run(run) : runWithGatewayToolContinuationContext(run);
  const run = async () => {
    const settledReply = params.reply ?? (await completion?.take());
    const deliverRequesterReply: Parameters<
      typeof runSessionsSendA2AFlow
    >[0]["deliverRequesterReply"] = completion
      ? async ({ message, extraSystemPrompt }) => {
          const {
            runAnnounceAgentCall,
            isGatewayAgentRunPending,
            resolvePrivateCompletionDeliveryResult,
          } = await import("../subagents/announce/subagent-announce-completion-delivery.js");
          completion.assertCurrent();
          const request = completion.request;
          const idempotencyKey = `announce:sessions-send:${request.runId}:completion`;
          const timeoutMs = resolveSubagentAnnounceTimeoutMs(getRuntimeConfig());
          let accepted = false;
          const inputProvenance = {
            kind: "inter_session" as const,
            sourceSessionKey: request.targetSessionKey,
            sourceTool: "subagent_announce",
            sourceRole: "subagent" as const,
          };
          const isCurrent = () => {
            try {
              request.custody.assertCurrent();
              return true;
            } catch {
              return false;
            }
          };
          const dispatch = () =>
            runAnnounceAgentCall({
              agentParams: {
                message: annotateInterSessionPromptText(message, inputProvenance),
                extraSystemPrompt,
                agentId: request.requesterAgentId,
                sessionKey: request.requesterSessionKey,
                expectedExistingSessionId: request.requesterSessionId,
                expectedExistingSessionLifecycleRevision:
                  params.requesterSession?.lifecycleRevision ?? null,
                idempotencyKey,
                inputProvenance,
                deliver: false,
                sourceReplyDeliveryMode: "message_tool_only",
                channel: params.requesterOrigin?.channel ?? INTERNAL_MESSAGE_CHANNEL,
                accountId: params.requesterOrigin?.accountId,
                to: params.requesterOrigin?.to,
                threadId: stringifyRouteThreadId(params.requesterOrigin?.threadId),
              },
              privateCompletion: true,
              expectFinal: true,
              onAccepted: (payload) => {
                const receipt = asOptionalRecord(payload);
                if (receipt?.runId !== idempotencyKey) {
                  throw new Error("Private completion acceptance does not identify its input.");
                }
                accepted ||= receipt.admissionPending !== true;
              },
              signal: request.custody.signal,
              isExecutionAllowed: isCurrent,
              isSourceSessionAdmissionAllowed: isCurrent,
            });
          const deliver = async () => {
            let response: unknown;
            let responseLost = false;
            try {
              response = await dispatch();
            } catch (error) {
              // Authoritative failures keep their interrupted private input for
              // explicit recovery. A lost response may still own an active turn.
              if (!accepted || isGatewayProtocolResponseError(error)) {
                throw error;
              }
              request.custody.assertCurrent();
              responseLost = true;
            }
            const readReceipt = () => {
              const receipt = asOptionalRecord(response);
              if (receipt?.runId !== idempotencyKey) {
                throw new Error("Private completion response belongs to another input.");
              }
              return receipt;
            };
            if (responseLost || isGatewayAgentRunPending(readReceipt())) {
              const result = await waitForAgentRunReply({
                runId: idempotencyKey,
                timeoutMs,
                untilTerminal: true,
                callGateway: <T>(options: Parameters<typeof callAgentToolGatewayRequest>[0]) =>
                  callAgentToolGatewayRequest<T>({
                    ...options,
                    signal: options.signal
                      ? AbortSignal.any([request.custody.signal, options.signal])
                      : request.custody.signal,
                    assertDispatchCurrent: () => {
                      request.custody.assertCurrent();
                      options.assertDispatchCurrent?.();
                    },
                  }),
              });
              request.custody.assertCurrent();
              if (result.status !== "ok") {
                throw new Error(
                  result.error ?? `Private requester turn ended with ${result.status}.`,
                );
              }
              // A successful run permits receipt-only replay of this exact
              // input. Failed or timed-out processing must never execute again here.
              response = await dispatch();
            }
            const delivery = await resolvePrivateCompletionDeliveryResult(readReceipt());
            request.custody.signal.throwIfAborted();
            if (params.requesterOrigin?.channel && params.requesterOrigin.to) {
              request.custody.assertCurrent();
            }
            if (!delivery.delivered) {
              throw new Error(delivery.error ?? "Private requester input was not processed.");
            }
          };
          const promptedAt = Date.now();
          await (request.requesterAuthority
            ? request.requesterAuthority.run(idempotencyKey, deliver)
            : deliver());
          const requester = params.requesterDeliveryGeneration;
          if (requester) {
            recordSessionParticipantBestEffort({
              agentId: requester.agentId,
              sessionKey: requester.sessionKey,
              storePath: requester.storePath,
              identity: { type: "agent", id: request.targetAgentId },
              promptedAt,
            });
          }
        }
      : undefined;
    return runSessionsSendA2AFlow({
      ...params,
      deliverRequesterReply,
      reply: settledReply,
    });
  };
  // No caller-owned transcript/resource scope may survive in the detached turn.
  const admitted = createDeferredCore();
  void continueOwned(() => {
    admitted.resolve();
    return runWithGatewayDetachedWorkContinuation(
      () =>
        runOutsidePreparedModelRuntimePluginGenerationScope(() =>
          runWithoutOwnedSessionTranscriptWrites(run),
        ),
      "session:a2a-send",
    );
  })
    .then(() => completion?.close())
    .catch((error: unknown) => {
      completion?.close(error);
      admitted.resolve();
      log.warn("sessions_send reply flow admission failed", {
        runId: params.runId,
        error: formatErrorMessage(error),
      });
    });
  return admitted.promise;
}

type SessionsSendReplyContext = Omit<
  Parameters<typeof startSessionsSendReplyFlow>[0],
  "runId" | "skip" | "completion" | "reply"
>;

/** Bind result routing to the captured requester and select its single completion owner. */
export function prepareSessionsSendReplyContext(params: {
  callerOwnsCompletion: boolean;
  requesterIsSubagent: boolean;
  ownedTask: boolean;
  isIsolatedCronRequester: boolean;
  targetIsSubagent: boolean;
  requesterSessionKey: string;
  targetSession: Parameters<typeof isRequesterParentOfBackgroundAcpSession>[0];
  requesterTarget: GatewaySessionStoreTargetWithStore;
  requesterSessionId?: string;
  context: Omit<
    SessionsSendReplyContext,
    "replyMode" | "requesterSession" | "requesterDeliveryGeneration"
  >;
}): SessionsSendReplyContext {
  const requesterSessionEntry = params.requesterTarget.store[params.requesterTarget.canonicalKey];
  const requesterSessionId = params.requesterSessionId ?? requesterSessionEntry?.sessionId;
  const requesterSession = requesterSessionId
    ? {
        sessionId: requesterSessionId,
        lifecycleRevision: requesterSessionEntry?.lifecycleRevision,
      }
    : undefined;
  const requesterDeliveryGeneration =
    requesterSessionEntry && requesterSession
      ? {
          agentId: params.requesterTarget.agentId,
          storePath: params.requesterTarget.storePath,
          sessionKey: params.requesterTarget.canonicalKey,
          ...requesterSession,
          lifecycleRevision: requesterSession.lifecycleRevision ?? null,
        }
      : undefined;
  const taskOwned =
    params.callerOwnsCompletion ||
    params.requesterIsSubagent ||
    params.ownedTask ||
    params.isIsolatedCronRequester ||
    isRequesterParentOfBackgroundAcpSession(params.targetSession, params.requesterSessionKey);
  return {
    ...params.context,
    requesterSession,
    requesterDeliveryGeneration,
    replyMode: taskOwned ? undefined : params.targetIsSubagent ? "one-way" : "peer",
  };
}

/** Resolve one accepted send inline or transfer its existing result custody before returning. */
export async function finishSessionsSendReply(params: {
  start: SessionsSendStart;
  completion?: FollowupCompletionOwner;
  registryCompletion: boolean;
  watchField: { watched?: boolean };
  replyContext: SessionsSendReplyContext;
  targetSession: GatewaySessionStoreTargetWithStore;
  cfg: OpenClawConfig;
  requesterAgentId: string;
  promptedAt: number;
  timeoutSeconds: number;
  timeoutMs: number;
  targetIsSubagent: boolean;
  isIsolatedCronRequester: boolean;
}) {
  const {
    start,
    completion,
    registryCompletion,
    watchField,
    replyContext,
    targetSession,
    cfg,
    requesterAgentId,
    promptedAt,
    timeoutSeconds,
    timeoutMs,
    targetIsSubagent,
    isIsolatedCronRequester,
  } = params;
  if (!start.ok) {
    return start.result;
  }
  const acceptedTargetSessionKey = start.a2aSessionKey ?? replyContext.targetSessionKey;
  // Steering and registered completion owners retain their delivery obligation.
  const delayedDelivery = {
    status:
      registryCompletion || (replyContext.replyMode && start.targetDisposition === "queued")
        ? "pending"
        : "skipped",
  } as const;
  recordSessionToolActionFact({
    operation: "send",
    fact: "committed",
    targetAgentId: replyContext.targetAgentId,
    targetSessionKey: acceptedTargetSessionKey,
  });
  try {
    const acceptedTarget = start.a2aSessionKey
      ? await resolveGatewaySessionStoreTargetInWorker({
          cfg,
          key: acceptedTargetSessionKey,
          agentId: replyContext.targetAgentId,
          projection: "full",
        })
      : targetSession;
    if (start.a2aSessionKey && !acceptedTarget.store[acceptedTarget.canonicalKey]) {
      throw new Error("Accepted Cron parent has no stored session entry.");
    }
    recordSessionParticipantBestEffort({
      identity: { type: "agent", id: requesterAgentId },
      promptedAt,
      agentId: acceptedTarget.agentId,
      sessionKey: acceptedTarget.canonicalKey,
      storePath: acceptedTarget.storePath,
      onError: (error) => log.warn("failed to record session participant", { error }),
    });
  } catch (error) {
    log.warn("failed to record session participant", { error });
  }
  const runId = start.runId;
  const accepted = () =>
    jsonResult({
      runId,
      status: "accepted",
      sessionKey: replyContext.displayKey,
      targetDisposition: start.targetDisposition,
      delivery: delayedDelivery,
      ...watchField,
    });
  const startReplyFlow = (notifyRequesterOnWaitFailure: boolean) =>
    startSessionsSendReplyFlow({
      ...replyContext,
      runId,
      completion,
      skip: registryCompletion || delayedDelivery.status === "skipped",
      targetSessionKey: acceptedTargetSessionKey,
      displayKey: start.a2aSessionKey ?? replyContext.displayKey,
      notifyRequesterOnWaitFailure: notifyRequesterOnWaitFailure && !isIsolatedCronRequester,
    });
  const result =
    timeoutSeconds === 0
      ? undefined
      : completion
        ? await completion.take(timeoutMs)
        : await waitForAgentRunReply({ runId, timeoutMs, callGateway: replyContext.callGateway });
  if (!result) {
    await startReplyFlow(true);
    return accepted();
  }
  completion?.close();

  if (result.status === "timeout") {
    if (result.pendingError === true && result.error?.trim()) {
      await startReplyFlow(targetIsSubagent);
      return jsonResult({
        runId,
        status: "timeout",
        error: result.error,
        sentBeforeError: true,
        sessionKey: replyContext.displayKey,
        delivery: delayedDelivery,
        ...watchField,
      });
    }
    if (!isTerminalAgentWaitTimeout(result)) {
      await startReplyFlow(true);
      return accepted();
    }
  }
  if (result.status === "timeout" || result.status === "error") {
    return jsonResult({
      runId,
      status: result.status,
      error: result.error ?? (result.status === "timeout" ? "agent run timed out" : "agent error"),
      sentBeforeError: true,
      sessionKey: replyContext.displayKey,
      ...watchField,
    });
  }
  return sendReplyResult({ runId, sessionKey: replyContext.displayKey, ...watchField }, result);
}
