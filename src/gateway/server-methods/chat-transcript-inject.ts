// Chat transcript injection appends gateway-authored assistant rows while
// preserving agent-session parent links and transcript update notifications.
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  findTranscriptEvent,
  persistSessionTranscriptTurn,
  type TranscriptEvent,
} from "../../config/sessions/session-accessor.js";
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

function transcriptEventRecord(event: TranscriptEvent): Record<string, unknown> | undefined {
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : undefined;
}

function transcriptEventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  const message = transcriptEventRecord(event)?.message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function transcriptEventId(event: TranscriptEvent): string | undefined {
  const id = transcriptEventRecord(event)?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

type InjectedAssistantIdempotencyTarget = {
  agentId?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
};

async function findInjectedAssistantMessageByIdempotencyKey(params: {
  idempotencyKey: string;
  target: InjectedAssistantIdempotencyTarget;
}): Promise<{ messageId: string; message: Record<string, unknown> } | undefined> {
  if (!params.target.sessionId || !params.target.sessionKey) {
    return undefined;
  }
  // The in-lock duplicate check resolves through the already-resolved
  // sessionFile when present so the lookup reads the file being appended to.
  // findTranscriptEvent scans newest-first with early exit, keeping the hot
  // idempotent append path from materializing the whole transcript.
  const found = await findTranscriptEvent(
    {
      ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
      ...(params.target.sessionFile ? { sessionFile: params.target.sessionFile } : {}),
      sessionId: params.target.sessionId,
      sessionKey: params.target.sessionKey,
      ...(params.target.storePath ? { storePath: params.target.storePath } : {}),
    },
    (candidate) => {
      const message = transcriptEventMessage(candidate);
      return message?.role === "assistant" && message.idempotencyKey === params.idempotencyKey;
    },
  );
  const message = found ? transcriptEventMessage(found.event) : undefined;
  if (!message) {
    return undefined;
  }
  // Legacy shipped transcripts can carry assistant rows without top-level ids;
  // fall back to the idempotency key so re-issued aborts still dedupe there.
  const messageId = (found ? transcriptEventId(found.event) : undefined) ?? params.idempotencyKey;
  return { messageId, message };
}

/** Append a gateway-authored assistant message while preserving transcript parent links. */
export async function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath?: string;
  storePath?: string;
  sessionId?: string;
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

  try {
    if (!params.transcriptPath && (!params.storePath || !params.sessionId || !params.sessionKey)) {
      return { ok: false, error: "transcript identity not resolved" };
    }
    const assistantScopedIdempotency =
      params.idempotencyKey && params.storePath && params.sessionId && params.sessionKey
        ? {
            idempotencyKey: params.idempotencyKey,
            target: {
              ...(params.agentId ? { agentId: params.agentId } : {}),
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              storePath: params.storePath,
            },
          }
        : undefined;
    const turn = await persistSessionTranscriptTurn(
      {
        sessionKey: params.sessionKey ?? "",
        ...(params.transcriptPath ? { sessionFile: params.transcriptPath } : {}),
        ...(params.storePath ? { storePath: params.storePath } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
      },
      {
        updateMode: "inline",
        touchSessionEntry: Boolean(params.storePath && params.sessionId && params.sessionKey),
        ...(params.config ? { config: params.config } : {}),
        messages: [
          {
            message: messageBody,
            idempotencyLookup: assistantScopedIdempotency ? "caller-checked" : "scan",
            now,
            useRawWhenLinear: true,
            shouldAppend: assistantScopedIdempotency
              ? async (target) =>
                  !(await findInjectedAssistantMessageByIdempotencyKey({
                    idempotencyKey: assistantScopedIdempotency.idempotencyKey,
                    target,
                  }))
              : undefined,
          },
        ],
      },
    );
    const appended = turn.messages[0];
    if (!appended) {
      if (assistantScopedIdempotency) {
        const existing = await findInjectedAssistantMessageByIdempotencyKey(
          assistantScopedIdempotency,
        );
        if (existing) {
          return { ok: true, messageId: existing.messageId, message: existing.message };
        }
      }
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
