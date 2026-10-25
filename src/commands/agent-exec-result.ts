import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent.js";

type AgentExecPayload = {
  text?: string;
  mediaUrl?: string | null;
  mediaUrls?: string[];
  isError?: boolean;
  isReasoning?: boolean;
  isCommentary?: boolean;
};

type AgentExecRawPayload = AgentExecPayload & Record<string, unknown>;

export type AgentExecRunResult = {
  payloads?: AgentExecRawPayload[];
  meta: EmbeddedAgentRunMeta;
};

type AgentExecStatus = "ok" | "error" | "timeout";

export type AgentExecEnvelope = ReturnType<typeof classifyAgentExecResult>;

function projectAgentExecPayload(payload: AgentExecRawPayload): AgentExecPayload {
  return {
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(payload.mediaUrl !== undefined ? { mediaUrl: payload.mediaUrl } : {}),
    ...(Array.isArray(payload.mediaUrls) ? { mediaUrls: [...payload.mediaUrls] } : {}),
    ...(payload.isError === true ? { isError: true } : {}),
    ...(payload.isReasoning === true ? { isReasoning: true } : {}),
    ...(payload.isCommentary === true ? { isCommentary: true } : {}),
  };
}

/** Classify an embedded result into the strict `agent exec` process contract. */
export function classifyAgentExecResult(
  result: AgentExecRunResult,
  fallbackExhausted = false,
  projectedErrorPayload?: string | true,
) {
  const meta = result.meta;
  const errorPayload = result.payloads?.find((payload) => payload.isError === true);
  const errorPayloadMessage =
    typeof projectedErrorPayload === "string"
      ? projectedErrorPayload
      : typeof errorPayload?.text === "string" && errorPayload.text.trim()
        ? errorPayload.text
        : undefined;
  const hasErrorPayload = projectedErrorPayload !== undefined || errorPayload !== undefined;
  const payloads = (result.payloads ?? []).map(projectAgentExecPayload);
  if (typeof projectedErrorPayload === "string") {
    const projectedErrorIndex = payloads.findIndex(
      (payload) => payload.isError !== true && payload.text === projectedErrorPayload,
    );
    if (projectedErrorIndex >= 0) {
      payloads[projectedErrorIndex] = {
        ...payloads[projectedErrorIndex],
        isError: true,
      };
    }
  }
  const timeout = meta.stopReason === "timeout" || meta.timeoutPhase !== undefined;
  const failed =
    fallbackExhausted ||
    meta.aborted === true ||
    meta.error !== undefined ||
    meta.stopReason === "error" ||
    hasErrorPayload;
  const status: AgentExecStatus = timeout ? "timeout" : failed ? "error" : "ok";
  // An abort with no error text of its own names its cause instead of the generic
  // failure text, so the message agrees with the "aborted" error kind below.
  const failureMessage = failed
    ? meta.aborted
      ? "Agent run aborted"
      : "Agent run failed"
    : undefined;
  const errorMessage = timeout
    ? (meta.error?.message ?? errorPayloadMessage ?? "Agent run timed out")
    : fallbackExhausted
      ? (meta.error?.message ?? errorPayloadMessage ?? "All model fallback candidates failed")
      : (meta.error?.message ?? errorPayloadMessage ?? failureMessage);
  const errorKind = timeout
    ? "timeout"
    : fallbackExhausted
      ? "fallback_exhausted"
      : meta.error?.kind
        ? meta.error.kind
        : meta.aborted
          ? "aborted"
          : hasErrorPayload
            ? "error_payload"
            : failed
              ? "agent_error"
              : undefined;
  const agentMeta = meta.agentMeta;
  const payloadText = payloads
    .filter(
      (payload) =>
        payload.isError !== true &&
        payload.isReasoning !== true &&
        payload.isCommentary !== true &&
        typeof payload.text === "string" &&
        payload.text.trim().length > 0,
    )
    .map((payload) => payload.text!.trimEnd())
    .join("\n");
  return {
    ok: status === "ok",
    status,
    final:
      payloadText ||
      (!hasErrorPayload ? result.meta.finalAssistantVisibleText?.trimEnd() : "") ||
      "",
    payloads,
    ...(agentMeta?.usage ? { usage: agentMeta.usage } : {}),
    ...(agentMeta?.costUsd !== undefined ? { costUsd: agentMeta.costUsd } : {}),
    ...(agentMeta?.codeModeEngaged !== undefined
      ? { codeModeEngaged: agentMeta.codeModeEngaged }
      : {}),
    ...(agentMeta?.assistantTurns !== undefined
      ? { assistantTurns: agentMeta.assistantTurns }
      : {}),
    ...(agentMeta?.bridgeCalls ? { bridgeCalls: agentMeta.bridgeCalls } : {}),
    ...(meta.toolSummary ? { toolSummary: meta.toolSummary } : {}),
    model: agentMeta?.model ?? null,
    provider: agentMeta?.provider ?? null,
    sessionId: agentMeta?.sessionId ?? "",
    ...(errorMessage && errorKind ? { error: { message: errorMessage, kind: errorKind } } : {}),
  };
}
