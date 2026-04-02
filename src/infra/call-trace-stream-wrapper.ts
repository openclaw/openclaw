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
  flowId?: string;
  callIndex: number;
  provider?: string;
  modelId?: string;
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
    flowId: params.flowId,
    callIndex: params.callIndex,
    provider: params.provider,
    model: params.modelId,
    usage: usage ?? undefined,
    durationMs: Date.now() - callStartedAt,
    status: errorMessage ? "error" : "ok",
    ...(errorMessage ? { errorMessage } : {}),
  });
}

async function* wrapIterable(
  iterable: AsyncIterable<unknown>,
  params: EmitParams,
  callStartedAt: number,
): AsyncGenerator {
  let usage: ReturnType<typeof extractUsage> | undefined;
  let errorMessage: string | undefined;
  try {
    for await (const evt of iterable) {
      const e = evt as { type?: string; message?: { usage?: unknown } };
      if (e.type === "message_end" && e.message?.usage) {
        usage = extractUsage(e.message.usage);
      }
      yield evt;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    emitCallEvent(params, callStartedAt, usage, errorMessage);
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
    flowId?: string;
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
    const emitParams: EmitParams = {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      flowId: params.flowId,
      callIndex,
      provider: params.provider,
      modelId: params.modelId,
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
