import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
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

/** Legacy peers observe a run; native child followups consume their retained result. */
export function startSessionsSendReplyFlow(
  params: Parameters<typeof runSessionsSendA2AFlow>[0] & {
    runId: string;
    skip: boolean;
    reply?: FollowupReply;
    completion?: FollowupCompletionOwner;
  },
) {
  if (params.skip) {
    return;
  }
  const { completion } = params;
  const continueOwned = completion
    ? <T>(run: () => Promise<T>) => completion.request.custody.run(run)
    : runWithGatewayToolContinuationContext;
  const run = async () => {
    const settledReply = params.reply ?? (await completion?.take());
    const callGateway: AgentToolGatewayRequestCaller | undefined =
      completion && params.callGateway
        ? (request) => {
            if (request.method === "agent" && !isRecord(request.params)) {
              throw new Error("Missing completion turn parameters.");
            }
            return params.callGateway!({
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
          }
        : params.callGateway;
    try {
      await runSessionsSendA2AFlow({
        ...params,
        callGateway,
        roundOneReply: settledReply?.replyText,
        sourceReplyDelivered: settledReply?.sourceReplyDelivered,
        settledReply,
        waitRunId: settledReply || completion ? undefined : params.runId,
        replyRunId: params.runId,
      });
    } finally {
      completion?.close();
    }
  };
  // No caller-owned transcript/resource scope may survive in the detached turn.
  const failed = (error: unknown) => {
    completion?.close(error);
    log.warn("sessions_send announce flow admission failed", {
      runId: params.runId,
      error: formatErrorMessage(error),
    });
  };
  try {
    void continueOwned(() =>
      runWithGatewayDetachedWorkContinuation(
        () =>
          runOutsidePreparedModelRuntimePluginGenerationScope(() =>
            runWithoutOwnedSessionTranscriptWrites(run),
          ),
        "session:a2a-send",
      ),
    ).catch(failed);
  } catch (error) {
    failed(error);
  }
}
