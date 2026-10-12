import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { z } from "zod";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { toOpenAiChatCompletionsUsage, type OpenAiChatCompletionsUsage } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
  type ConversationToolCall,
  IMAGE_ONLY_USER_MESSAGE,
  renderConversationToolCall,
} from "./agent-prompt.js";
import { sendInvalidRequest, sendJson, sendUnauthorized, setSseHeaders } from "./http-common.js";
import { assertGatewayHttpRequestCurrent } from "./http-request-authority.js";
import { rejectDisabledGatewayUpload } from "./http-upload-policy.js";
import {
  authorizeOpenAiCompatibleHttpSession,
  isGatewayRequestContextError,
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
} from "./http-utils.js";
import { resolveAgentRunUsage } from "./openai-agent-run-usage.js";
import {
  validateOpenAiSamplingParams,
  resolveOpenAiStreamParams,
  resolveResponseFormat,
  resolveStopSequences,
} from "./openai-compat-errors.js";
import {
  runOpenAiCompatibleAgentCommand,
  type OpenAiCompatibleHttpOptions,
} from "./openai-compatible-agent-run.js";
import {
  prepareOpenAiCompatibleHttpRequest,
  sendOpenAiCompatibleJsonResponse,
  startOpenAiCompatibleStream,
} from "./openai-compatible-http.js";
import { resolveOpenAiChatCompletionsLimits } from "./openai-compatible-input-limits.js";
import { extractImageUrls, resolveImagesForRequest } from "./openai-http-images.js";
import { applyToolChoice, resolveChatToolChoice } from "./openai-tool-choice.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { areGatewayUploadsEnabled, GATEWAY_UPLOADS_DISABLED_MESSAGE } from "./upload-policy.js";

const OpenAiChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullish(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  messages: z.array(z.unknown()).optional(),
  user: z.string().optional(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  response_format: z.unknown().optional(),
  frequency_penalty: z.number().nullish(),
  presence_penalty: z.number().nullish(),
  seed: z.number().nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
});

type OpenAiChatCompletionRequest = z.infer<typeof OpenAiChatCompletionRequestSchema>;

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractClientToolsFromChatRequest(
  tools: OpenAiChatCompletionRequest["tools"],
): ClientToolDefinition[] {
  const clientTools: ClientToolDefinition[] = [];
  for (const rawTool of tools ?? []) {
    const tool = asOptionalRecord(rawTool);
    if (!tool) {
      throw new Error("each tool must be an object");
    }
    if (tool.type !== "function") {
      throw new Error("only function tools are supported");
    }
    const functionValue = asOptionalRecord(tool.function);
    if (!functionValue) {
      throw new Error("tool.function is required");
    }
    const name = normalizeOptionalString(functionValue.name);
    if (!name) {
      throw new Error("tool.function.name is required");
    }
    const { description, strict } = functionValue;
    const parameters = asOptionalRecord(functionValue.parameters);
    clientTools.push({
      type: "function",
      function: {
        name,
        ...(typeof description === "string" ? { description } : {}),
        ...(parameters ? { parameters } : {}),
        ...(typeof strict === "boolean" ? { strict } : {}),
      },
    });
  }
  return clientTools;
}

type ChatCompletionStreamIdentity = { runId: string; model: string; created: number };

function writeChatCompletionChunk(
  res: ServerResponse,
  identity: ChatCompletionStreamIdentity,
  chunk: { choices: ChatCompletionChunk.Choice[]; usage?: OpenAiChatCompletionsUsage },
) {
  writeSse(res, {
    id: identity.runId,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    ...chunk,
  });
}

function writeChatCompletionChoice(
  res: ServerResponse,
  identity: ChatCompletionStreamIdentity,
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: "stop" | "length" | "tool_calls" | null = null,
) {
  writeChatCompletionChunk(res, identity, {
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function writeAssistantToolCallsIncrementalChunks(
  res: ServerResponse,
  params: ChatCompletionStreamIdentity & {
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
  },
) {
  for (const [index, call] of params.toolCalls.entries()) {
    writeChatCompletionChoice(res, params, {
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: "" },
        },
      ],
    });

    // Empty arguments still produce a delta after the tool identity frame.
    let start = 0;
    do {
      const end = avoidTrailingHighSurrogateBreak(
        call.arguments,
        start,
        Math.min(start + 256, call.arguments.length),
      );
      writeChatCompletionChoice(res, params, {
        tool_calls: [
          {
            index,
            function: { arguments: call.arguments.slice(start, end) },
          },
        ],
      });
      start = end;
    } while (start < call.arguments.length);
  }
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      const record = asOptionalObjectRecord(part);
      if (!record) {
        return undefined;
      }
      const { type, text, input_text: inputText } = record;
      if ((type === "text" || type === "input_text") && typeof text === "string") {
        return text;
      }
      return typeof inputText === "string" ? inputText : undefined;
    });
    const text = parts.filter(Boolean).join("\n");
    return text.trim() || parts.every((part) => part !== undefined) ? text : undefined;
  }
  return undefined;
}

function stringifyToolCallArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

function extractAssistantToolCalls(value: unknown): ConversationToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: ConversationToolCall[] = [];
  for (const rawCall of value) {
    const call = asOptionalRecord(rawCall);
    if (!call) {
      continue;
    }
    const id = normalizeOptionalString(call.id);
    const functionValue = asOptionalRecord(call.function);
    const name = normalizeOptionalString(functionValue?.name);
    if (!id || !name) {
      continue;
    }
    const argumentsValue = stringifyToolCallArguments(functionValue?.arguments);
    calls.push({ id, name, arguments: argumentsValue });
  }
  return calls;
}

type ActiveTurnContext = {
  activeUserMessageIndex: number;
  imageUrls: ReturnType<typeof extractImageUrls>;
};

function resolveActiveTurnContext(messages: unknown[] = []): ActiveTurnContext {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = asOptionalObjectRecord(messages[i]);
    if (!msg) {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    const imageUrls: ActiveTurnContext["imageUrls"] =
      normalizedRole === "user" ? extractImageUrls(msg.content) : { kind: "valid", urls: [] };
    return {
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      imageUrls,
    };
  }
  return {
    activeUserMessageIndex: -1,
    imageUrls: { kind: "valid", urls: [] },
  };
}

function buildAgentPrompt(
  messages: unknown[] | undefined,
  activeTurnContext: Pick<ActiveTurnContext, "activeUserMessageIndex" | "imageUrls">,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const hasActiveTurnImage =
    activeTurnContext.imageUrls.kind === "valid" && activeTurnContext.imageUrls.urls.length > 0;

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, rawMessage] of (messages ?? []).entries()) {
    const msg = asOptionalObjectRecord(rawMessage);
    if (!msg) {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = (
      role === "function" && msg.content === null ? "" : extractTextContent(msg.content)
    )?.trim();
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }
    const assistantToolCalls =
      normalizedRole === "assistant" ? extractAssistantToolCalls(msg.tool_calls) : [];
    const assistantToolCallsSummary = assistantToolCalls.map(renderConversationToolCall).join("\n");

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const baseMessageContent =
      normalizedRole === "user" &&
      !content &&
      hasActiveTurnImage &&
      i === activeTurnContext.activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    const messageContent = [baseMessageContent, assistantToolCallsSummary]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    const name = normalizeOptionalString(msg.name) ?? "";
    const toolCallId = normalizeOptionalString(msg.tool_call_id) ?? "";
    // Empty output completes a named call; absent or malformed content does not.
    const isToolResult =
      normalizedRole === "tool" &&
      Boolean(role === "function" ? name : toolCallId) &&
      content !== undefined &&
      (role !== "function" || typeof msg.content === "string" || msg.content === null);
    if (!messageContent && !isToolResult) {
      continue;
    }

    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : toolCallId
            ? `Tool:${toolCallId}`
            : name
              ? `Tool:${name}`
              : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
      internalStreamError:
        normalizedRole === "assistant" &&
        normalizeOptionalString(msg.stopReason) === "error" &&
        messageContent.trim() === STREAM_ERROR_FALLBACK_TEXT,
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveChatCompletionUsage(result: unknown): OpenAiChatCompletionsUsage {
  return toOpenAiChatCompletionsUsage(resolveAgentRunUsage(result));
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiCompatibleHttpOptions<GatewayHttpChatCompletionsConfig>,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await prepareOpenAiCompatibleHttpRequest(req, res, {
    ...opts,
    pathname: "/v1/chat/completions",
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
    schema: OpenAiChatCompletionRequestSchema,
  });
  if (!handled) {
    return handled !== false;
  }
  const { payload, abortController, senderIsOwner } = handled;
  const hasMedia = (payload.messages ?? []).some((message) => {
    const content = asOptionalObjectRecord(message)?.content;
    return (
      Array.isArray(content) &&
      content.some((part) => {
        const type = asOptionalObjectRecord(part)?.type;
        return type === "image_url" || type === "file";
      })
    );
  });
  if (rejectDisabledGatewayUpload(res, hasMedia)) {
    return true;
  }
  const stream = payload.stream === true;
  const streamIncludeUsage = stream && payload.stream_options?.include_usage === true;
  const model = payload.model ?? "openclaw";
  const user = payload.user;
  let responseFormat: Record<string, unknown> | undefined;
  try {
    responseFormat = resolveResponseFormat(payload.response_format);
  } catch (err) {
    sendInvalidRequest(res, `Invalid response_format: ${formatErrorMessage(err).trim()}`);
    return true;
  }
  let stop: string[] | undefined;
  try {
    stop = resolveStopSequences(payload.stop);
  } catch (err) {
    sendInvalidRequest(res, `Invalid stop: ${formatErrorMessage(err).trim()}`);
    return true;
  }
  const samplingError = validateOpenAiSamplingParams({
    temperature: payload.temperature,
    topP: payload.top_p,
    frequencyPenalty: payload.frequency_penalty,
    presencePenalty: payload.presence_penalty,
    seed: payload.seed,
  });
  if (samplingError) {
    sendInvalidRequest(res, samplingError);
    return true;
  }
  const streamParams = resolveOpenAiStreamParams({
    maxTokens: payload.max_completion_tokens ?? payload.max_tokens ?? undefined,
    temperature: payload.temperature ?? undefined,
    topP: payload.top_p ?? undefined,
    responseFormat,
    frequencyPenalty: payload.frequency_penalty ?? undefined,
    presencePenalty: payload.presence_penalty ?? undefined,
    seed: payload.seed ?? undefined,
    stop,
  });

  let agentId: string;
  let sessionKey: string;
  let messageChannel: string;
  try {
    ({ agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
      req,
      model,
      user,
      sessionPrefix: "openai",
    }));
  } catch (err) {
    if (isGatewayRequestContextError(err)) {
      sendInvalidRequest(res, err.message);
      return true;
    }
    throw err;
  }
  const creationAuth = authorizeGatewaySessionCreation({
    cfg: getRuntimeConfig(),
    ...(handled.requestAuth.operatorRoleActor
      ? { actor: handled.requestAuth.operatorRoleActor }
      : { profileId: handled.requestAuth.authenticatedUserProfile?.profileId }),
    agentId,
  });
  if (creationAuth) {
    sendJson(res, 403, {
      error: { message: creationAuth.message, type: "forbidden" },
    });
    return true;
  }
  const sessionAuth = authorizeOpenAiCompatibleHttpSession({
    agentId,
    sessionKey,
    requestAuth: handled.requestAuth,
    senderIsOwner,
  });
  if (!sessionAuth.allowed) {
    sendJson(res, 403, { error: { message: sessionAuth.message, type: "forbidden" } });
    return true;
  }
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendInvalidRequest(res, modelError);
    return true;
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext);
  let toolChoice: ReturnType<typeof applyToolChoice>;
  try {
    const parsedClientTools = extractClientToolsFromChatRequest(payload.tools);
    toolChoice = applyToolChoice(parsedClientTools, resolveChatToolChoice(payload.tool_choice));
  } catch (err) {
    sendInvalidRequest(res, `Invalid tools/tool_choice: ${formatErrorMessage(err).trim()}`);
    return true;
  }
  let images: ImageContent[];
  try {
    assertGatewayHttpRequestCurrent(handled.requestAuth);
    images = await resolveImagesForRequest(
      activeTurnContext,
      limits,
      abortController.signal,
      () => {
        assertGatewayHttpRequestCurrent(handled.requestAuth);
        if (hasMedia && !areGatewayUploadsEnabled(getRuntimeConfig())) {
          throw new Error(GATEWAY_UPLOADS_DISABLED_MESSAGE);
        }
      },
    );
  } catch (err) {
    if (abortController.signal.aborted) {
      return true;
    }
    if (handled.requestAuth.hasCurrentClientAuthority?.() === false) {
      sendUnauthorized(res);
      return true;
    }
    if (rejectDisabledGatewayUpload(res, hasMedia)) {
      return true;
    }
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendInvalidRequest(res, "Invalid image_url content in `messages`.");
    return true;
  }

  // Preparation can yield across a runtime policy publication, including the last image.
  if (rejectDisabledGatewayUpload(res, hasMedia)) {
    return true;
  }
  if (!prompt.message && images.length === 0) {
    sendInvalidRequest(res, "Missing user message in `messages`.");
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const streamIdentity = { runId, model, created };
  const mergedExtraSystemPrompt = [prompt.extraSystemPrompt, toolChoice.extraSystemPrompt]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const runAgentCommand = () =>
    runOpenAiCompatibleAgentCommand({
      message: prompt.message,
      extraSystemPrompt: mergedExtraSystemPrompt,
      images,
      clientTools: toolChoice.tools,
      modelOverride,
      sessionKey,
      runId,
      messageChannel,
      senderIsOwner,
      requestAuth: handled.requestAuth,
      operatorScopes: handled.operatorScopes,
      abortSignal: abortController.signal,
      hasCurrentClientAuthority: handled.requestAuth.hasCurrentClientAuthority,
      hasClientUploads: hasMedia,
      streamParams,
      resolveGatewayContext: opts.resolveGatewayContext,
    });

  if (!stream) {
    return sendOpenAiCompatibleJsonResponse({
      res,
      signal: abortController.signal,
      constraint: toolChoice.constraint,
      run: runAgentCommand,
      failureLabel: "openai-compat: chat completion failed",
      complete: ({ result, stopReason, toolCalls, text, toolChoiceError }) => {
        const usage = resolveChatCompletionUsage(result);

        if (toolChoiceError) {
          sendJson(res, 502, {
            error: {
              message: toolChoiceError,
              type: "api_error",
            },
          });
          return;
        }

        const content = text || (toolCalls ? "" : "No response from OpenClaw.");
        sendJson(res, 200, {
          id: runId,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content,
                ...(toolCalls
                  ? {
                      tool_calls: toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      })),
                    }
                  : {}),
              },
              finish_reason: toolCalls ? "tool_calls" : stopReason === "length" ? "length" : "stop",
            },
          ],
          usage,
        });
      },
    });
  }

  setSseHeaders(res);
  writeChatCompletionChoice(res, streamIdentity, { role: "assistant" });
  handled.onDisconnect = startOpenAiCompatibleStream({
    protocol: "chat",
    res,
    runId,
    signal: abortController.signal,
    constraint: toolChoice.constraint,
    run: runAgentCommand,
    writeDelta: (content) => writeChatCompletionChoice(res, streamIdentity, { content }),
    complete: ({ result, delta, toolCalls, stopReason }) => {
      if (delta) {
        writeChatCompletionChoice(res, streamIdentity, { content: delta });
      }
      if (toolCalls) {
        writeAssistantToolCallsIncrementalChunks(res, { ...streamIdentity, toolCalls });
      }
      writeChatCompletionChoice(
        res,
        streamIdentity,
        {},
        toolCalls ? "tool_calls" : stopReason === "length" ? "length" : "stop",
      );
      if (streamIncludeUsage) {
        writeChatCompletionChunk(res, streamIdentity, {
          choices: [],
          usage: resolveChatCompletionUsage(result),
        });
      }
    },
    fail: (error) => writeSse(res, { error }),
  });
  return true;
}
