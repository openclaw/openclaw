import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "./diagnostic-events.js";

type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function extractUsage(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as UsageLike;
  const input = u.input ?? u.input_tokens;
  const output = u.output ?? u.output_tokens;
  const cacheRead = u.cacheRead ?? u.cache_read_input_tokens;
  const cacheWrite = u.cacheWrite ?? u.cache_creation_input_tokens;
  if (input == null && output == null && cacheRead == null && cacheWrite == null) {
    return undefined;
  }
  const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) || undefined;
  return {
    input: input ?? undefined,
    output: output ?? undefined,
    cacheRead: cacheRead ?? undefined,
    cacheWrite: cacheWrite ?? undefined,
    total,
  };
}

type EmitParams = {
  sessionKey?: string;
  sessionId?: string;
  turnId?: string;
  callIndex: number;
  provider?: string;
  modelId?: string;
  requestText?: string;
  replyText?: string;
};

function emitCallEvent(
  params: EmitParams,
  callStartedAt: number,
  usage: ReturnType<typeof extractUsage>,
  errorMessage?: string,
) {
  emitDiagnosticEvent({
    type: "model.call",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    turnId: params.turnId,
    callIndex: params.callIndex,
    provider: params.provider,
    model: params.modelId,
    usage: usage ?? undefined,
    durationMs: Date.now() - callStartedAt,
    status: errorMessage ? "error" : "ok",
    ...(errorMessage ? { errorMessage } : {}),
    requestText: params.requestText,
    replyText: params.replyText,
  });
}

async function* wrapIterable(
  iterable: AsyncIterable<unknown>,
  params: EmitParams,
  callStartedAt: number,
): AsyncGenerator {
  let usage: ReturnType<typeof extractUsage> | undefined;
  let errorMessage: string | undefined;
  let replyText: string | undefined;
  try {
    for await (const evt of iterable) {
      const e = evt as { type?: string; message?: { usage?: unknown; content?: unknown } };
      if (e.type === "message_end" && e.message?.usage) {
        usage = extractUsage(e.message.usage);

        // Extract replyText from the message content
        if (e.message.content) {
          if (typeof e.message.content === "string") {
            replyText = e.message.content
              .replace(/[\r\n\t]+/g, " ")
              .trim()
              .slice(0, 240);
          } else if (Array.isArray(e.message.content)) {
            // Handle array of TextContent | ImageContent
            const textContents = e.message.content
              .filter(
                (item: unknown) =>
                  typeof item === "object" &&
                  item !== null &&
                  "type" in item &&
                  (item as { type?: string }).type === "text" &&
                  "text" in item &&
                  typeof (item as { text?: string }).text === "string",
              )
              .map((item: unknown) => (item as { text: string }).text);
            if (textContents.length > 0) {
              replyText = textContents
                .join(" ")
                .replace(/[\r\n\t]+/g, " ")
                .trim()
                .slice(0, 240);
            }
          }
        }
      }
      yield evt;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // Update params with replyText before emitting
    const finalParams = {
      ...params,
      replyText,
    };
    emitCallEvent(finalParams, callStartedAt, usage, errorMessage);
  }
}

/**
 * Wraps a StreamFn so that every individual LLM API call emits a `model.call`
 * diagnostic event with per-call usage and wall-clock duration.
 */
export function wrapStreamFnCallTrace(
  baseFn: StreamFn,
  params: {
    cfg?: OpenClawConfig;
    sessionKey?: string;
    sessionId?: string;
    turnId?: string;
    provider?: string;
    modelId?: string;
    callIndexRef: { value: number };
  },
): StreamFn {
  if (
    !params.cfg ||
    !isDiagnosticsEnabled(params.cfg) ||
    !params.cfg.diagnostics?.callTrace?.enabled
  ) {
    return baseFn;
  }

  return (model, context, options) => {
    const callIndex = params.callIndexRef.value++;
    const callStartedAt = Date.now();

    // Extract requestText from the last user message
    let requestText: string | undefined;
    if (context?.messages?.length) {
      const userMessages = context.messages.filter(
        (msg: unknown) =>
          typeof msg === "object" &&
          msg !== null &&
          "role" in msg &&
          (msg as { role?: string }).role === "user",
      );
      if (userMessages.length > 0) {
        const lastUserMessage = userMessages[userMessages.length - 1];
        if (typeof lastUserMessage.content === "string") {
          requestText = lastUserMessage.content
            .replace(/[\r\n\t]+/g, " ")
            .trim()
            .slice(0, 240);
        } else if (Array.isArray(lastUserMessage.content)) {
          // Handle array of TextContent | ImageContent
          const textContents = lastUserMessage.content
            .filter(
              (item: unknown) =>
                typeof item === "object" &&
                item !== null &&
                "type" in item &&
                (item as { type?: string }).type === "text" &&
                "text" in item &&
                typeof (item as { text?: string }).text === "string",
            )
            .map((item: unknown) => (item as { text: string }).text);
          if (textContents.length > 0) {
            requestText = textContents
              .join(" ")
              .replace(/[\r\n\t]+/g, " ")
              .trim()
              .slice(0, 240);
          }
        }
      }
    }

    const emitParams: EmitParams = {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      turnId: params.turnId,
      callIndex,
      provider: params.provider,
      modelId: params.modelId,
      requestText,
    };

    const maybeStream = baseFn(model, context, options);

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream as Promise<AsyncIterable<unknown>>).then(
        (stream) =>
          wrapIterable(stream, emitParams, callStartedAt) as unknown as ReturnType<StreamFn>,
        (err: unknown) => {
          emitCallEvent(
            emitParams,
            callStartedAt,
            undefined,
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        },
      ) as unknown as ReturnType<StreamFn>;
    }

    return wrapIterable(
      maybeStream as unknown as AsyncIterable<unknown>,
      emitParams,
      callStartedAt,
    ) as unknown as ReturnType<StreamFn>;
  };
}
