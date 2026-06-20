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

/** Extract concatenated visible text from an assistant message block array. */
function extractMessageBlockText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? ((block as { text: string }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * Find the latest assistant message whose visible text matches,
 * skipping non-message entries (e.g. openclaw.cache-ttl) in the reverse scan.
 * Returns null when no match is found or the transcript is empty.
 */
async function findLatestAssistantMessageIdByText(
  transcriptPath: string,
  expectedText: string,
): Promise<{ messageId: string; message: Record<string, unknown> } | null> {
  if (!expectedText) return null;
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const r = record as Record<string, unknown>;
    if (r.type !== "message") continue;
    const message = r.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;
    const existingText = extractMessageBlockText(message.content);
    if (existingText === expectedText) {
      return { messageId: typeof r.id === "string" ? r.id : expectedText, message };
    }
  }
  return null;
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

  // Deduplicate against the canonical agent reply already in the transcript.
  // After the agent writes its reply, cache-ttl is appended as a child and
  // becomes the leaf. Without this check the injected append parents to
  // cache-ttl, creating a duplicate branch that WebChat renders twice.
  // See: https://github.com/openclaw/openclaw/issues/94930
  const expectedText = extractMessageBlockText(resolvedContent);
  if (expectedText) {
    const existing = await findLatestAssistantMessageIdByText(params.transcriptPath, expectedText);
    if (existing) {
      return { ok: true, messageId: existing.messageId, message: existing.message };
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
