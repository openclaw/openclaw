import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveGatewayRequestContext } from "./http-utils.js";
import type { CreateResponseBody, ItemParam, Usage } from "./open-responses.schema.js";
import {
  buildResponsesExecutionPlan,
  extractUsageFromResult,
  resolveStopReasonAndPendingToolCalls,
} from "./openresponses-http.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiToolFunction = {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
};

type OpenAiTool = {
  type?: unknown;
  function?: OpenAiToolFunction;
};

type OpenAiToolChoiceFunction = {
  name?: unknown;
};

type OpenAiChatToolCall = {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: unknown;
};

type PendingToolCall = { id: string; name: string; arguments: string };

type ChatCompletionMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

type ChatCompletionChunkChoice = {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: "stop" | "tool_calls" | null;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendOpenAiError(
  res: ServerResponse,
  status: number,
  error: { message: string; type: string; param?: string; code?: string },
) {
  sendJson(res, status, { error });
}

function createOpenAiUsage(usage: Usage) {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}

function createChatToolCalls(toolCalls: PendingToolCall[]) {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: "function" as const,
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }));
}

function createChatCompletionChoice(params: {
  text: string;
  pendingToolCalls?: PendingToolCall[];
}): { index: number; message: ChatCompletionMessage; finish_reason: "stop" | "tool_calls" } {
  const hasToolCalls = Boolean(params.pendingToolCalls && params.pendingToolCalls.length > 0);
  return {
    index: 0,
    message: {
      role: "assistant",
      content: hasToolCalls ? null : params.text,
      tool_calls: hasToolCalls ? createChatToolCalls(params.pendingToolCalls ?? []) : undefined,
    },
    finish_reason: hasToolCalls ? "tool_calls" : "stop",
  };
}

function createChunk(params: { runId: string; model: string; choice: ChatCompletionChunkChoice }) {
  return {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [params.choice],
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(
    res,
    createChunk({
      runId: params.runId,
      model: params.model,
      choice: { index: 0, delta: { role: "assistant" } },
    }),
  );
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(
    res,
    createChunk({
      runId: params.runId,
      model: params.model,
      choice: {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    }),
  );
}

function writeAssistantToolCallChunk(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    toolCalls: PendingToolCall[];
    finishReason: "tool_calls" | null;
  },
) {
  writeSse(
    res,
    createChunk({
      runId: params.runId,
      model: params.model,
      choice: {
        index: 0,
        delta: {
          tool_calls: params.toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id,
            type: "function" as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        },
        finish_reason: params.finishReason,
      },
    }),
  );
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeToolChoice(toolChoice: unknown): CreateResponseBody["tool_choice"] | undefined {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  if (!toolChoice || typeof toolChoice !== "object") {
    return undefined;
  }
  const record = toolChoice as { type?: unknown; function?: OpenAiToolChoiceFunction };
  if (record.type !== "function") {
    return undefined;
  }
  const name = typeof record.function?.name === "string" ? record.function.name.trim() : "";
  if (!name) {
    return { type: "function", function: { name: "" } };
  }
  return { type: "function", function: { name } };
}

function normalizeTools(value: unknown): ClientToolDefinition[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools: ClientToolDefinition[] = [];
  for (const tool of value) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const record = tool as OpenAiTool;
    if (record.type !== "function") {
      continue;
    }
    const name = typeof record.function?.name === "string" ? record.function.name.trim() : "";
    if (!name) {
      continue;
    }
    const description =
      typeof record.function?.description === "string" ? record.function.description : undefined;
    const parameters =
      record.function?.parameters && typeof record.function.parameters === "object"
        ? (record.function.parameters as Record<string, unknown>)
        : undefined;
    tools.push({
      type: "function",
      function: { name, description, parameters },
    });
  }
  return tools;
}

function normalizeToolCallId(value: unknown, index: number): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : `call_${index + 1}`;
}

function normalizeOpenAiMessages(messagesUnknown: unknown): ItemParam[] {
  const items: ItemParam[] = [];
  for (const [index, rawMessage] of asMessages(messagesUnknown).entries()) {
    if (!rawMessage || typeof rawMessage !== "object") {
      continue;
    }
    const role = typeof rawMessage.role === "string" ? rawMessage.role.trim() : "";
    const text = extractTextContent(rawMessage.content).trim();

    if (role === "tool") {
      const rawCallId =
        typeof rawMessage.tool_call_id === "string" ? rawMessage.tool_call_id.trim() : "";
      if (!text) {
        continue;
      }
      items.push({
        type: "function_call_output",
        call_id: rawCallId || normalizeToolCallId(undefined, index),
        output: text,
      });
      continue;
    }

    if (role === "assistant") {
      const toolCallsRaw = Array.isArray(rawMessage.tool_calls)
        ? (rawMessage.tool_calls as OpenAiChatToolCall[])
        : [];
      for (const toolCall of toolCallsRaw) {
        if (!toolCall || typeof toolCall !== "object") {
          continue;
        }
        const name =
          typeof toolCall.function?.name === "string" ? toolCall.function.name.trim() : "";
        if (!name) {
          continue;
        }
        const argsValue = toolCall.function?.arguments;
        items.push({
          type: "function_call",
          call_id: normalizeToolCallId(toolCall.id, index),
          name,
          arguments: typeof argsValue === "string" ? argsValue : "{}",
        });
      }
    }

    if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
      continue;
    }
    if (!text) {
      continue;
    }
    items.push({ type: "message", role, content: text });
  }
  return items;
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;
  const input = normalizeOpenAiMessages(payload.messages);
  const tools = normalizeTools(payload.tools);
  const toolChoice = normalizeToolChoice(payload.tool_choice);
  const maxOutputTokens =
    typeof payload.max_tokens === "number" && Number.isFinite(payload.max_tokens)
      ? payload.max_tokens
      : undefined;

  let responsePlan;
  try {
    responsePlan = buildResponsesExecutionPlan({
      input,
      tools,
      toolChoice,
      maxOutputTokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid request";
    const invalidToolConfig =
      message.includes("tool_choice") ||
      message.includes("tools were provided") ||
      message.includes("unknown tool");
    sendOpenAiError(res, 400, {
      message:
        message === "Missing user message in `input`."
          ? "Missing user message in `messages`."
          : invalidToolConfig
            ? message
            : "invalid request",
      type: "invalid_request_error",
      param:
        message === "Missing user message in `input`."
          ? "messages"
          : invalidToolConfig
            ? "tool_choice"
            : undefined,
    });
    return true;
  }

  const { sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const commandInput = {
    message: responsePlan.message,
    extraSystemPrompt: responsePlan.extraSystemPrompt,
    clientTools: responsePlan.clientTools.length > 0 ? responsePlan.clientTools : undefined,
    streamParams: responsePlan.streamParams,
    sessionKey,
    runId,
    deliver: false as const,
    messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: true as const,
  };

  if (!stream) {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
      const usage = createOpenAiUsage(extractUsageFromResult(result));
      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
      const hasToolCalls = stopReason === "tool_calls" && (pendingToolCalls?.length ?? 0) > 0;
      const content = hasToolCalls ? "" : resolveAgentResponseText(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          createChatCompletionChoice({
            text: content,
            pendingToolCalls: hasToolCalls ? pendingToolCalls : undefined,
          }),
        ],
        usage,
      });
    } catch (err) {
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendOpenAiError(res, 500, {
        message: "internal error",
        type: "api_error",
        code: "internal_error",
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;
  let finalToolCalls: PendingToolCall[] | undefined;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId || closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
      if (closed) {
        return;
      }

      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
      finalToolCalls = stopReason === "tool_calls" ? pendingToolCalls : undefined;

      if (!sawAssistantDelta && !finalToolCalls?.length) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content: resolveAgentResponseText(result),
          finishReason: null,
        });
      }
    } catch (err) {
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (closed) {
        return;
      }
      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: "Error: internal error",
        finishReason: "stop",
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        if (finalToolCalls?.length) {
          if (!wroteRole) {
            wroteRole = true;
            writeAssistantRoleChunk(res, { runId, model });
          }
          writeAssistantToolCallChunk(res, {
            runId,
            model,
            toolCalls: finalToolCalls,
            finishReason: "tool_calls",
          });
        } else {
          writeSse(
            res,
            createChunk({
              runId,
              model,
              choice: {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            }),
          );
        }
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
