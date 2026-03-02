import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadConfig } from "../config/config.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";
import { injectTimestamp, timestampOptsFromConfig } from "./server-methods/agent-timestamp.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
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

type AgentPromptResult = {
  message: string;
  /** Raw text of the last user/tool message, used for command/directive parsing. */
  commandText: string;
  extraSystemPrompt?: string;
};

function buildAgentPrompt(messagesUnknown: unknown): AgentPromptResult {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];
  let lastNonAssistantContent = "";

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    if (!role || !content) {
      continue;
    }
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    if (normalizedRole === "user" || normalizedRole === "tool") {
      lastNonAssistantContent = content;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: content },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    commandText: lastNonAssistantContent || message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openai" });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function buildMsgContext(params: {
  prompt: AgentPromptResult;
  sessionKey: string;
  runId: string;
  cfg: ReturnType<typeof loadConfig>;
}): MsgContext {
  const { prompt, sessionKey, runId, cfg } = params;
  const stampedMessage = injectTimestamp(prompt.message, timestampOptsFromConfig(cfg));
  return {
    Body: prompt.message,
    BodyForAgent: stampedMessage,
    BodyForCommands: prompt.commandText,
    RawBody: prompt.message,
    CommandBody: prompt.commandText,
    SessionKey: sessionKey,
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    ChatType: "direct",
    CommandAuthorized: true,
    MessageSid: runId,
    // Pass OpenAI system/developer messages as the group system prompt so they
    // are included in the agent's extra system prompt by the reply pipeline.
    GroupSystemPrompt: prompt.extraSystemPrompt,
  };
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

  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenAiSessionKey({ req, agentId, user });
  const prompt = buildAgentPrompt(payload.messages);
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const cfg = loadConfig();
  const resolvedAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const ctx = buildMsgContext({ prompt, sessionKey, runId, cfg });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: resolvedAgentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });

  if (!stream) {
    const finalReplyParts: string[] = [];
    const dispatcher = createReplyDispatcher({
      ...prefixOptions,
      onError: (err) => {
        logWarn(`openai-compat: chat completion dispatch failed: ${String(err)}`);
      },
      deliver: async (_payload, info) => {
        if (info.kind !== "final") {
          return;
        }
        const text = _payload.text?.trim() ?? "";
        if (text) {
          finalReplyParts.push(text);
        }
      },
    });

    try {
      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: { runId, onModelSelected },
      });

      const content =
        finalReplyParts
          .map((part) => part.trim())
          .filter(Boolean)
          .join("\n\n")
          .trim() || "No response from OpenClaw.";

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    }
    return true;
  }

  // --- Streaming path ---
  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;
  const finalReplyParts: string[] = [];

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
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
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  const dispatcher = createReplyDispatcher({
    ...prefixOptions,
    onError: (err) => {
      logWarn(`openai-compat: streaming dispatch failed: ${String(err)}`);
    },
    deliver: async (_payload, info) => {
      if (info.kind !== "final") {
        return;
      }
      const text = _payload.text?.trim() ?? "";
      if (text) {
        finalReplyParts.push(text);
      }
    },
  });

  void (async () => {
    try {
      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: { runId, onModelSelected },
      });

      if (closed) {
        return;
      }

      // If no streaming deltas arrived, send the collected final reply parts.
      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content =
          finalReplyParts
            .map((part) => part.trim())
            .filter(Boolean)
            .join("\n\n")
            .trim() || "No response from OpenClaw.";

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
    } catch (err) {
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (closed) {
        return;
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
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
