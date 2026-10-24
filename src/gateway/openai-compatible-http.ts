import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { z } from "zod";
import { emitAgentEvent, onAgentEventForRun } from "../infra/agent-events.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.types.js";
import { logWarn } from "../logger.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../process/gateway-work-admission.js";
import {
  createAssistantTextStream,
  resolveAssistantResultText,
} from "./agent-event-assistant-text.js";
import {
  parseGatewayJsonRequest,
  retainGatewayHttpResponseWork,
  sendJson,
  sendMissingScopeForbidden,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import {
  authorizeOpenAiCompatibleHttpModelOverride,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import {
  readOpenAiHttpRunTerminal,
  resolveOpenAiCompatibleAgentError,
  type OpenAiCompatiblePendingToolCall,
} from "./openai-compatible-agent-run.js";
import {
  resolveToolChoiceConstraintError,
  type ToolChoiceConstraint,
} from "./openai-tool-choice.js";

type StreamError = { message: string; type: string; code?: string };
type StreamResult = {
  result: unknown;
  stopReason: string | undefined;
  toolCalls: OpenAiCompatiblePendingToolCall[] | undefined;
  text: string;
  delta: string;
  lifecycleError?: string;
};

const REPLACEMENT_ERROR =
  "Assistant output cannot be represented as an append-only response stream.";

function incompleteTurnError(text: string): StreamError {
  return { message: text, type: "api_error", code: "incomplete_turn" };
}

export async function prepareOpenAiCompatibleHttpRequest<T extends z.ZodType>(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & { pathname: string; maxBodyBytes: number; schema: T },
) {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    ...opts,
    requiredOperatorMethod: "chat.send",
  });
  if (!handled) {
    return handled;
  }
  const client = { abortController: new AbortController() };
  watchClientDisconnect(req, res, client.abortController);
  const modelAuth = authorizeOpenAiCompatibleHttpModelOverride(req, handled.requestAuth);
  if (!modelAuth.allowed) {
    sendMissingScopeForbidden(res, modelAuth.missingScope);
    return undefined;
  }
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);
  const payload = parseGatewayJsonRequest(res, handled.body, opts.schema);
  return payload ? Object.assign(client, handled, { payload, senderIsOwner }) : undefined;
}

export async function sendOpenAiCompatibleJsonResponse(params: {
  res: ServerResponse;
  signal: AbortSignal;
  constraint: ToolChoiceConstraint | undefined;
  run: () => Promise<unknown>;
  failureLabel: string;
  complete: (
    result: Omit<StreamResult, "delta" | "lifecycleError"> & { toolChoiceError?: string },
  ) => void;
  fail?: (
    error: ReturnType<typeof resolveOpenAiCompatibleAgentError>,
    result?: unknown,
    incompleteTurnText?: string,
  ) => void;
}): Promise<true> {
  const fail: NonNullable<typeof params.fail> =
    params.fail ?? ((error) => sendJson(params.res, error.status, { error: error.error }));
  try {
    const result = await params.run();
    if (params.signal.aborted) {
      return true;
    }
    const { runFailed, stopReason, pendingToolCalls, incompleteTurnText } =
      readOpenAiHttpRunTerminal(result);
    if (runFailed) {
      if (incompleteTurnText !== undefined) {
        fail(
          { status: 500, error: incompleteTurnError(incompleteTurnText) },
          result,
          incompleteTurnText,
        );
        return true;
      }
      throw new Error("agent run failed");
    }
    params.complete({
      result,
      stopReason,
      toolCalls:
        stopReason === "tool_calls" && pendingToolCalls?.length ? pendingToolCalls : undefined,
      text: resolveAssistantResultText(result) ?? "",
      toolChoiceError: resolveToolChoiceConstraintError(params.constraint, pendingToolCalls),
    });
  } catch (error) {
    if (!params.signal.aborted) {
      logWarn(`${params.failureLabel}: ${String(error)}`);
      fail(resolveOpenAiCompatibleAgentError(error));
    }
  }
  return true;
}

/** Own run settlement and text delivery; adapters only encode their wire protocol. */
export function startOpenAiCompatibleStream(params: {
  protocol: "chat" | "responses";
  res: ServerResponse;
  runId: string;
  signal: AbortSignal;
  constraint: ToolChoiceConstraint | undefined;
  run: () => Promise<unknown>;
  writeDelta: (delta: string) => void;
  complete: (result: StreamResult) => void;
  fail: (error: StreamError, result?: unknown, incompleteTurnText?: string) => void;
}): void {
  if (params.signal.aborted) {
    return;
  }
  const { res, runId } = params;
  const chat = params.protocol === "chat";
  const textStream = createAssistantTextStream(Boolean(params.constraint));
  let closed = false;
  let finalizeScheduled = false;
  let observedTerminal = false;
  let terminalPhase: "end" | "error" = "end";
  let responseTerminal: { phase: "end" | "error"; error?: string } | undefined;
  let streamError: StreamError | undefined;
  let unrepresentableReplacement = false;
  let settled: Omit<StreamResult, "text" | "delta" | "lifecycleError"> | undefined;

  const close = () => {
    closed = true;
    unsubscribe();
    params.signal.removeEventListener("abort", onAbort);
  };
  const finish = () => {
    writeDone(res);
    res.end();
  };
  const fail = (error: StreamError, result?: unknown, incompleteTurnText?: string) => {
    if (closed) {
      return;
    }
    close();
    params.fail(error, result, incompleteTurnText);
    finish();
  };
  const requestFinalize = () => {
    if (closed || finalizeScheduled || !settled || (!chat && !responseTerminal)) {
      return;
    }
    // Responses waits a turn for lifecycle listeners; Chat waits for same-turn text flushes.
    finalizeScheduled = true;
    const schedule = chat ? queueMicrotask : setImmediate;
    schedule(() => {
      if (closed || !settled) {
        return;
      }
      if (streamError || unrepresentableReplacement) {
        fail(streamError ?? { message: REPLACEMENT_ERROR, type: "server_error" }, settled.result);
        return;
      }
      const text = textStream.complete(
        resolveAssistantResultText(settled.result),
        settled.toolCalls ? "" : "No response from OpenClaw.",
      );
      if (!text.startsWith(textStream.streamedText)) {
        fail(
          { message: REPLACEMENT_ERROR, type: chat ? "api_error" : "server_error" },
          settled.result,
        );
        return;
      }
      close();
      params.complete({
        ...settled,
        text,
        delta: text.slice(textStream.streamedText.length),
        lifecycleError:
          responseTerminal?.phase === "error"
            ? responseTerminal.error || "Agent run failed"
            : undefined,
      });
      finish();
    });
  };
  const unsubscribe = onAgentEventForRun(runId, (evt: AgentEventRuntimePayload) => {
    if (closed) {
      return;
    }
    if (evt.stream === "assistant") {
      const { delta, replacement } = textStream.update(evt.data, evt.assistantProjection?.rawDelta);
      if (chat && replacement === "unrepresentable") {
        streamError ??= { message: REPLACEMENT_ERROR, type: "api_error" };
        return;
      }
      if (!chat && replacement) {
        unrepresentableReplacement = replacement === "unrepresentable";
      }
      if (delta) {
        params.writeDelta(delta);
      }
    } else if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (chat && phase === "start") {
        observedTerminal = false;
      }
      if (phase === "end" || phase === "error") {
        observedTerminal = true;
        responseTerminal ??= { phase, error: normalizeOptionalString(evt.data?.error) };
        if (chat && phase === "error" && terminalPhase !== "error") {
          streamError ??= {
            message: normalizeOptionalString(evt.data?.error) ?? "Agent run failed",
            type: "api_error",
          };
        }
        requestFinalize();
      }
    }
  });

  // Agent cleanup and deferred wire delivery settle independently during shutdown.
  const releaseAgent = retainGatewayRootWorkAdmissionContinuation();
  const releaseStream = retainGatewayHttpResponseWork(res);
  const onAbort = () => {
    close();
    releaseStream();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  void (async () => {
    try {
      const result = await params.run();
      if (closed) {
        return;
      }
      const { runFailed, stopReason, pendingToolCalls, incompleteTurnText } =
        readOpenAiHttpRunTerminal(result);
      if (runFailed) {
        terminalPhase = "error";
        if (incompleteTurnText !== undefined) {
          const delta = incompleteTurnText.startsWith(textStream.streamedText)
            ? incompleteTurnText.slice(textStream.streamedText.length)
            : "";
          if (delta && !params.constraint) {
            params.writeDelta(delta);
          }
          fail(incompleteTurnError(incompleteTurnText), result, incompleteTurnText);
          return;
        }
        fail({ message: "internal error", type: "api_error" }, result);
        return;
      }
      if (chat && streamError) {
        fail(streamError);
        return;
      }
      const toolError = resolveToolChoiceConstraintError(params.constraint, pendingToolCalls);
      if (toolError) {
        fail({ message: toolError, type: "api_error" }, result);
        return;
      }
      settled = {
        result,
        stopReason,
        toolCalls:
          stopReason === "tool_calls" && pendingToolCalls?.length ? pendingToolCalls : undefined,
      };
      requestFinalize();
    } catch (error) {
      if (closed) {
        return;
      }
      terminalPhase = "error";
      logWarn(
        `${chat ? "openai-compat: streaming chat completion" : "openresponses: streaming response"} failed: ${String(error)}`,
      );
      fail(resolveOpenAiCompatibleAgentError(error, chat ? streamError : undefined).error);
    } finally {
      releaseAgent?.();
      // Never replace a provider's terminal event with a second outcome.
      if (!observedTerminal && (terminalPhase === "error" || !closed)) {
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: terminalPhase } });
      }
    }
  })();
}
