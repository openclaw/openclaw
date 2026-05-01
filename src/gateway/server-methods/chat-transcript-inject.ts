import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

const SESSION_MANAGER_APPEND_MAX_BYTES = 8 * 1024 * 1024;

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

function transcriptHasParentLinkedEntries(transcriptPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = "";
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (lineHasParentLinkedEntry(line)) {
          return true;
        }
      }
    }
    return lineHasParentLinkedEntry(carry + decoder.end());
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function lineHasParentLinkedEntry(line: string): boolean {
  if (!line.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; parentId?: unknown };
    return parsed.type !== "session" && typeof parsed.id === "string" && "parentId" in parsed;
  } catch {
    return false;
  }
}

function shouldUseRawAppend(transcriptPath: string): boolean {
  try {
    const stat = fs.statSync(transcriptPath);
    return (
      stat.size > SESSION_MANAGER_APPEND_MAX_BYTES &&
      !transcriptHasParentLinkedEntries(transcriptPath)
    );
  } catch {
    return false;
  }
}

function appendRawAssistantMessageToTranscript(params: {
  transcriptPath: string;
  message: AppendMessageArg & Record<string, unknown>;
  now: number;
}): { messageId: string } {
  const messageId = randomUUID();
  const entry = {
    type: "message",
    id: messageId,
    timestamp: new Date(params.now).toISOString(),
    message: params.message,
  };
  fs.appendFileSync(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
  return { messageId };
}

export function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  label?: string;
  /** When set, used as the assistant `content` array (e.g. text + embedded audio blocks). */
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  now?: number;
}): GatewayInjectedTranscriptAppendResult {
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
  };

  try {
    if (shouldUseRawAppend(params.transcriptPath)) {
      const { messageId } = appendRawAssistantMessageToTranscript({
        transcriptPath: params.transcriptPath,
        message: messageBody,
        now,
      });
      emitSessionTranscriptUpdate({
        sessionFile: params.transcriptPath,
        message: messageBody,
        messageId,
      });
      return { ok: true, messageId, message: messageBody };
    }

    // IMPORTANT: Use SessionManager so the entry is attached to the current leaf via parentId.
    // Raw jsonl appends break the parent chain and can hide compaction summaries from context.
    const sessionManager = SessionManager.open(params.transcriptPath);
    const messageId = sessionManager.appendMessage(messageBody);
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
