import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayProtocolResponseError } from "../../../packages/gateway-client/src/protocol-request.js";
import { getRuntimeConfig } from "../../config/config.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import { waitForAgentRunReply } from "../run-wait.js";
import { resolveSubagentAnnounceTimeoutMs } from "../subagents/announce/subagent-announce-delivery-retry.js";
import type { FollowupCompletionOwner } from "../subagents/completion/session-followup-completion.types.js";
import {
  callAgentToolGatewayRequest,
  runWithGatewayToolContinuationContext,
} from "./in-process-gateway.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
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
            const delivery = resolvePrivateCompletionDeliveryResult(readReceipt());
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
