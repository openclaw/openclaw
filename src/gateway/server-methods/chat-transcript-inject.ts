// Chat transcript injection appends gateway-authored assistant rows while
// preserving agent-session parent links and transcript update notifications.
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import { streamSessionTranscriptLinesReverse } from "../../config/sessions/transcript-stream.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

/** Metadata persisted on gateway-injected assistant messages that mark a stopped run. */
export type GatewayInjectedAbortMeta = {
  aborted: true;
  origin: "rpc" | "stop-command";
  runId: string;
};

/** Result shape returned after appending an assistant row to a session transcript. */
export type GatewayInjectedTranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

/** Hash marker used to dedupe companion TTS text/audio supplements. */
export type GatewayInjectedTtsSupplementMarker = {
  textSha256: string;
};

function resolveInjectedAssistantContent(params: {
  message: string;
  label?: string;
  content?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  // Preserve rich content arrays when callers already prepared media blocks;
  // only the first text block is rewritten so block ordering stays intact.
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

/**
 * Reverse-reads the transcript to find the latest assistant message whose
 * visible text matches the expected value. Non-message entries (e.g.
 * `openclaw.cache-ttl` custom markers) are skipped so they don't mask the
 * canonical assistant reply. Returns the existing message id when found,
 * or undefined when no match exists.
 */
async function findLatestAssistantMessageIdByText(
  transcriptPath: string,
  expectedText: string,
): Promise<string | undefined> {
  if (!expectedText) {
    return undefined;
  }
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: {
          role?: unknown;
          content?: unknown;
        };
      };
      const candidate = parsed.message;
      if (!candidate || candidate.role !== "assistant") {
        continue;
      }
      // Stop at the first assistant message: only the tail entry matters.
      const candidateText = extractTranscriptContentText(candidate.content);
      if (candidateText !== expectedText) {
        return undefined;
      }
      return typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractTranscriptContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const pieces = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return ((block as { text: string }).text ?? "").trim();
      }
      return "";
    })
    .filter(Boolean);
  return pieces.length > 0 ? pieces.join("\n").trim() : undefined;
}

/** Append a gateway-authored assistant message while preserving transcript parent links. */
export async function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath: string;
  sessionKey?: string;
  agentId?: string;
  message: string;
  label?: string;
  /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  ttsSupplement?: GatewayInjectedTtsSupplementMarker;
  now?: number;
  config?: OpenClawConfig;
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
  const messageBody: AppendMessageArg & Record<string, unknown> = {
    role: "assistant",
    // Gateway-injected assistant messages can include non-model content blocks (e.g. embedded TTS audio).
    content: resolvedContent as unknown as Extract<
      AppendMessageArg,
      { role: "assistant" }
    >["content"],
    timestamp: now,
    // stopReason is a strict runner enum; this is not model output, but we still store it as a
    // normal assistant message so it participates in the session parentId chain.
    stopReason: "stop",
    usage,
    // Make these explicit so downstream tooling never treats this as model output.
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.ttsSupplement ? { openclawTtsSupplement: params.ttsSupplement } : {}),
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

  // Visible text used to deduplicate against the canonical assistant reply
  // already written by the agent's session manager. Check before acquiring the
  // write lock so dedup is cheap and TOCTOU risk is negligible (the agent has
  // already finished writing by the time the gateway injects).
  const expectedText = resolvedContent
    .filter(
      (c): c is { type: string; text: string } =>
        c && typeof c === "object" && c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (expectedText) {
    const existingId = await findLatestAssistantMessageIdByText(
      params.transcriptPath,
      expectedText,
    );
    if (existingId) {
      // Return the existing canonical-assistant id so callers that track the
      // last transcript message surface still see a stable message id. We do not
      // re-read the full message record here; the caller already has the text.
      return { ok: true, messageId: existingId, message: messageBody as Record<string, unknown> };
    }
  }

  try {
    const turn = await persistSessionTranscriptTurn(
      {
        sessionFile: params.transcriptPath,
        sessionKey: params.sessionKey ?? "",
        ...(params.agentId ? { agentId: params.agentId } : {}),
      },
      {
        updateMode: "inline",
        ...(params.config ? { config: params.config } : {}),
        messages: [
          {
            message: messageBody,
            now,
            useRawWhenLinear: true,
          },
        ],
      },
    );
    const appended = turn.messages[0];
    if (!appended) {
      return { ok: false, error: "gateway-injected assistant message was not appended" };
    }
    return {
      ok: true,
      messageId: appended.messageId,
      message: appended.message as Record<string, unknown>,
    };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}
