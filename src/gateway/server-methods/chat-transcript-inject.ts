import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionWriteLockAcquireTimeoutConfig } from "../../agents/session-write-lock.js";
import { appendSessionTranscriptMessage } from "../../config/sessions/transcript-append.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

export type GatewayInjectedAbortMeta = {
  aborted: true;
  origin: "rpc" | "stop-command";
  runId: string;
};

export type GatewayInjectedTranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

function resolveInjectedAssistantContent(params: {
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  if (params.content && params.content.length > 0) {
    if (!labelPrefix) {
      return params.content;
    }
    const first = params.content[0];
    if (
      first &&
      typeof first === "object" &&
      first.type === "text" &&
      typeof first.text === "string"
    ) {
      return [{ ...first, text: `${labelPrefix}${first.text}` }, ...params.content.slice(1)];
    }
    return [{ type: "text", text: labelPrefix.trim() }, ...params.content];
  }
  return [{ type: "text", text: `${labelPrefix}${params.message}` }];
}

export async function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  label?: string;
  /**
   * When set, stamps the persisted assistant entry's `provider` field so
   * downstream UIs (avatar/handle resolvers) can attribute the inject to a
   * non-OpenClaw source (e.g. "hermes", "codex"). Default remains "openclaw".
   */
  originAgent?: string;
  /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  now?: number;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<GatewayInjectedTranscriptAppendResult> {
  const now = params.now ?? Date.now();
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const resolvedContent = resolveInjectedAssistantContent({
    message: params.message,
    label: params.label,
    content: params.content,
  });
  // Normalize: trim whitespace, treat empty as unset. Keeps malformed attribution
  // values out of the persisted transcript even if the schema is permissive.
  const normalizedOriginAgent =
    typeof params.originAgent === "string" && params.originAgent.trim().length > 0
      ? params.originAgent.trim()
      : undefined;
  const messageBody: AppendMessageArg & Record<string, unknown> = {
    role: "assistant",
    // Gateway-injected assistant messages can include non-model content blocks (e.g. embedded TTS audio).
    content: resolvedContent as unknown as Extract<
      AppendMessageArg,
      { role: "assistant" }
    >["content"],
    timestamp: now,
    // Pi stopReason is a strict enum; this is not model output, but we still store it as a
    // normal assistant message so it participates in the session parentId chain.
    stopReason: "stop",
    usage,
    // Make these explicit so downstream tooling never treats this as model output.
    // `provider: "openclaw"` + `model: "gateway-injected"` is the sentinel pair the
    // replay-history filter (replay-history.ts) keys off to drop transcript-only
    // injected rows from being replayed back to the next model. Do not change these.
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
    // Display-only attribution. UI avatar/handle resolvers may key off this to render
    // the true source of a cross-agent inject (e.g. "hermes", "codex"). It does NOT
    // participate in replay filtering; the sentinel provider/model pair above continues
    // to mark this as transcript-only output regardless of originAgent.
    ...(normalizedOriginAgent ? { originAgent: normalizedOriginAgent } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.abortMeta
      ? {
          openclawAbort: {
            aborted: true,
            origin: params.abortMeta.origin,
            runId: params.abortMeta.runId,
          },
        }
      : {}),
  };

  try {
    const { messageId } = await appendSessionTranscriptMessage({
      transcriptPath: params.transcriptPath,
      message: messageBody,
      now,
      useRawWhenLinear: true,
      config: params.config,
    });
    emitSessionTranscriptUpdate({
      sessionFile: params.transcriptPath,
      message: messageBody,
      messageId,
    });
    return { ok: true, messageId, message: messageBody };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}
