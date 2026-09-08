import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { readToolValidationErrorSummary } from "../../agents/tool-error-summary.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { ChatTerminalState } from "../chat-abort.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatAborted, broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { GatewayRequestContext } from "./types.js";

type ChatSendAgentOutcomeContext = Pick<
  GatewayRequestContext,
  "agentRunSeq" | "broadcast" | "chatRunState" | "dedupe" | "getRuntimeConfig" | "nodeSendToSession"
>;

export function finalizeChatSendAgentOutcome(params: {
  context: ChatSendAgentOutcomeContext;
  runId: string;
  sessionKey: string;
  agentId?: string;
  hasReturnedAgentErrorPayloads: boolean;
  broadcastedSourceReplyFinal: boolean;
  successfulFinalOwnedElsewhere?: boolean;
  markTerminalBroadcasted: (state: ChatTerminalState) => void;
  terminalAlreadyBroadcasted?: boolean;
  terminalAlreadyBroadcastedState?: ChatTerminalState;
  returnedAgentErrorMessage?: string;
  runtimeClassification?: "cancellation" | "failure" | "success" | "timeout";
  runtimeOutcome?: Pick<AgentRunTerminalOutcome, "endedAt" | "stopReason">;
  toolErrorSummary?: string;
}): void {
  const alreadyAborted = params.context.chatRunState.hasAbortMarker(params.runId);
  const hasReturnedAgentError =
    params.hasReturnedAgentErrorPayloads && !params.broadcastedSourceReplyFinal;
  const validationAbortErrorMessage = hasReturnedAgentError
    ? readToolValidationErrorSummary(params.toolErrorSummary)
    : undefined;
  const terminalErrorMessage = validationAbortErrorMessage ?? params.returnedAgentErrorMessage;
  const terminalAlreadyBroadcasted = params.terminalAlreadyBroadcasted === true;
  const supersedesSuccessfulTerminal =
    terminalAlreadyBroadcasted && params.terminalAlreadyBroadcastedState === "final";
  const shouldBroadcastValidationAbort =
    hasReturnedAgentError &&
    !alreadyAborted &&
    !terminalAlreadyBroadcasted &&
    validationAbortErrorMessage !== undefined;
  // An error also supersedes an already-broadcast successful final: the run
  // terminalized as "final" before the host-authored failure reply settled.
  const shouldBroadcastAgentError =
    hasReturnedAgentError &&
    !alreadyAborted &&
    ((!terminalAlreadyBroadcasted && validationAbortErrorMessage === undefined) ||
      supersedesSuccessfulTerminal);
  const shouldBroadcastSuccessfulFinal =
    params.context.agentRunSeq.has(params.runId) &&
    !hasReturnedAgentError &&
    !alreadyAborted &&
    !terminalAlreadyBroadcasted &&
    !params.successfulFinalOwnedElsewhere;

  // A validated tool summary is already the authoritative safe terminal result.
  // It must win over the generic agent error returned after dispatch.
  if (shouldBroadcastValidationAbort) {
    params.markTerminalBroadcasted("aborted");
    params.context.chatRunState.getOrCreate(params.runId).abortMarker = createChatAbortMarker();
    broadcastChatAborted({
      context: params.context,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      errorMessage: validationAbortErrorMessage,
    });
  } else if (shouldBroadcastAgentError) {
    params.markTerminalBroadcasted("error");
    // Carry the already-derived timeout class into the one terminal error
    // frame. Re-inferring from message text or omitting errorKind would
    // publish a truthful-once but unclassified ACP timeout.
    broadcastChatError({
      context: params.context,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      errorMessage: terminalErrorMessage,
      ...(params.runtimeClassification === "timeout" ? { errorKind: "timeout" as const } : {}),
    });
  } else if (shouldBroadcastSuccessfulFinal) {
    params.markTerminalBroadcasted("final");
    broadcastChatFinal({
      context: params.context,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  }

  if (alreadyAborted) {
    return;
  }

  const returnedAgentError = hasReturnedAgentError
    ? errorShape(ErrorCodes.UNAVAILABLE, terminalErrorMessage ?? "agent returned an error payload")
    : undefined;
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    entry: {
      ts: Date.now(),
      ok: !hasReturnedAgentError,
      payload: hasReturnedAgentError
        ? {
            runId: params.runId,
            status:
              params.runtimeClassification === "timeout"
                ? ("timeout" as const)
                : ("error" as const),
            summary: terminalErrorMessage ?? "agent returned an error payload",
            ...(params.runtimeOutcome ? { endedAt: params.runtimeOutcome.endedAt } : {}),
            ...(params.runtimeOutcome?.stopReason
              ? { stopReason: params.runtimeOutcome.stopReason }
              : {}),
          }
        : params.runtimeClassification === "cancellation"
          ? buildAbortedChatSendPayload({
              runId: params.runId,
              endedAt: params.runtimeOutcome?.endedAt ?? Date.now(),
              stopReason: params.runtimeOutcome?.stopReason,
            })
          : {
              runId: params.runId,
              status: "ok" as const,
              ...(params.runtimeOutcome?.stopReason
                ? { stopReason: params.runtimeOutcome.stopReason }
                : {}),
            },
      ...(returnedAgentError ? { error: returnedAgentError } : {}),
    },
  });
}
