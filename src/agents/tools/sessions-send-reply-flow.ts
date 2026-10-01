import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import type {
  FollowupReply,
  FollowupCompletionOwner,
} from "../subagents/completion/session-followup-completion.types.js";
import {
  runWithGatewayToolContinuationContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
const log = createSubsystemLogger("agents/sessions-send");

/** Await custody transfer before returning the tool; result observation stays detached. */
export function startSessionsSendReplyFlow(
  params: Parameters<typeof runSessionsSendA2AFlow>[0] & {
    runId: string;
    skip: boolean;
    reply?: FollowupReply;
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
    const callGateway: AgentToolGatewayRequestCaller | undefined =
      completion && params.callGateway
        ? <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
            if (request.method === "agent" && !isRecord(request.params)) {
              throw new Error("Missing completion turn parameters.");
            }
            const dispatch = () =>
              params.callGateway!<T>({
                ...request,
                assertDispatchCurrent: () => {
                  completion.assertCurrent();
                  request.assertDispatchCurrent?.();
                },
                params:
                  request.method === "agent" && isRecord(request.params)
                    ? {
                        ...request.params,
                        expectedExistingSessionId: completion.request.requesterSessionId,
                      }
                    : request.params,
              });
            const authority = completion.request.requesterAuthority;
            if (request.method !== "agent" || !authority) {
              return dispatch();
            }
            const input = request.params;
            if (
              !isRecord(input) ||
              input.sessionKey !== completion.request.requesterSessionKey ||
              input.agentId !== completion.request.requesterAgentId ||
              typeof input.idempotencyKey !== "string" ||
              !isRecord(input.inputProvenance) ||
              input.inputProvenance.kind !== "inter_session" ||
              input.inputProvenance.sourceTool !== "subagent_announce" ||
              input.inputProvenance.sourceSessionKey !== completion.request.targetSessionKey
            ) {
              throw new Error("Followup authority cannot leave its original requester.");
            }
            return authority.run(input.idempotencyKey, dispatch);
          }
        : params.callGateway;
    return runSessionsSendA2AFlow({
      ...params,
      callGateway,
      roundOneReply: settledReply?.replyText,
      sourceReplyDelivered: settledReply?.sourceReplyDelivered,
      settledReply,
      waitRunId: settledReply || completion ? undefined : params.runId,
      replyRunId: params.runId,
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
      log.warn("sessions_send announce flow admission failed", {
        runId: params.runId,
        error: formatErrorMessage(error),
      });
    });
  return admitted.promise;
}
