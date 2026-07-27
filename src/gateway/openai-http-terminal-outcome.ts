// Canonical terminal projection shared by OpenAI-compatible HTTP surfaces.
import {
  buildAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { hasVisibleAgentPayload } from "../agents/embedded-agent-runner/message-visibility.js";

type OpenAiHttpAgentResult = {
  payloads?: Array<{
    isError?: boolean;
    isCommentary?: boolean;
    isCompactionNotice?: boolean;
    isFallbackNotice?: boolean;
    isReasoningSnapshot?: boolean;
    isStatusNotice?: boolean;
    text?: string;
    visible?: boolean;
  }>;
  meta?: {
    aborted?: boolean;
    error?: unknown;
    fallbackExhaustedFailure?: boolean;
    replayInvalid?: boolean;
    stopReason?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
  };
};

/** Preserve real provider failures even when the agent resolves its result. */
export function resolveOpenAiHttpAgentRunTerminalOutcome(
  result: unknown,
  previous?: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  const agentResult = result as OpenAiHttpAgentResult | null | undefined;
  const meta = agentResult?.meta;
  // Completed tool calls can intentionally make a successful turn unsafe to
  // replay. Replay safety alone is not a provider or terminal-run failure.
  // Recovery may retain a failed attempt before its final visible reply.
  // Only the last visible/error payload owns the HTTP terminal result.
  const terminalPayload = agentResult?.payloads?.findLast(
    (payload) =>
      payload.isError === true ||
      (payload.isCommentary !== true &&
        payload.isCompactionNotice !== true &&
        payload.isFallbackNotice !== true &&
        payload.isReasoningSnapshot !== true &&
        payload.isStatusNotice !== true &&
        payload.visible !== false &&
        hasVisibleAgentPayload(
          { payloads: [payload] },
          {
            includeErrorPayloads: false,
            includeReasoningPayloads: false,
            includeSilentReplyPayloads: false,
          },
        )),
  );
  const resultFailed =
    meta?.error != null ||
    meta?.fallbackExhaustedFailure === true ||
    terminalPayload?.isError === true;

  return mergeAgentRunTerminalOutcome(
    previous,
    buildAgentRunTerminalOutcome({
      status: meta?.aborted === true ? "timeout" : resultFailed ? "error" : "ok",
      error: meta?.error,
      stopReason: meta?.stopReason,
      livenessState: meta?.livenessState,
      timeoutPhase: meta?.timeoutPhase,
      providerStarted: meta?.providerStarted,
      startedAt: meta?.startedAt,
      endedAt: meta?.endedAt,
    }),
  );
}
