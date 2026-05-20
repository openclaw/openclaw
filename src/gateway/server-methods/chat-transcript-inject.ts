import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendSessionTranscriptMessage } from "../../config/sessions/transcript-append.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  /** True when an existing entry with matching idempotencyKey was returned. */
  deduped?: boolean;
  error?: string;
};

type GatewayInjectedRole = "assistant" | "user";

function resolveInjectedContent(params: {
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

async function appendInjectedMessageToTranscript(params: {
  role?: GatewayInjectedRole;
  transcriptPath: string;
  message: string;
  label?: string;
  /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  now?: number;
  config?: OpenClawConfig;
}): Promise<GatewayInjectedTranscriptAppendResult> {
  const role: GatewayInjectedRole = params.role === "user" ? "user" : "assistant";
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
  const resolvedContent = resolveInjectedContent({
    message: params.message,
    label: params.label,
    content: params.content,
  });
  const messageBody: AppendMessageArg & Record<string, unknown> =
    role === "assistant"
      ? {
          role,
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
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-injected",
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
        }
      : {
          role,
          content: resolvedContent as unknown as Extract<
            AppendMessageArg,
            { role: "user" }
          >["content"],
          timestamp: now,
          ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        };

  try {
    const {
      messageId,
      message: appendedMessage,
      deduped,
    } = await appendSessionTranscriptMessage({
      transcriptPath: params.transcriptPath,
      message: messageBody,
      now,
      useRawWhenLinear: true,
      config: params.config,
      // Pass the idempotency key as a first-class param so the locked write
      // path can dedupe atomically. The key is also embedded in the message
      // body above for backward-compatible on-disk inspection.
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    });
    if (!deduped) {
      emitSessionTranscriptUpdate({
        sessionFile: params.transcriptPath,
        message: appendedMessage,
        messageId,
      });
    }
    return {
      ok: true,
      messageId,
      message: appendedMessage as unknown as Record<string, unknown>,
      ...(deduped ? { deduped: true } : {}),
    };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

export async function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  label?: string;
  /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  now?: number;
  config?: OpenClawConfig;
}): Promise<GatewayInjectedTranscriptAppendResult> {
  return await appendInjectedMessageToTranscript({
    ...params,
    role: "assistant",
  });
}

export async function appendInjectedUserMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  now?: number;
  config?: OpenClawConfig;
}): Promise<GatewayInjectedTranscriptAppendResult> {
  return await appendInjectedMessageToTranscript({
    ...params,
    role: "user",
  });
}
