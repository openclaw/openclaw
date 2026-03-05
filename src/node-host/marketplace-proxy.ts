/**
 * Marketplace proxy — handles incoming proxy requests on the seller's node.
 *
 * When the gateway routes a buyer's request to this node, this module:
 * 1. Reads the seller's API key from config/env
 * 2. Calls the appropriate API (Hanzo Cloud or Anthropic direct)
 * 3. Streams chunks back via node.event (same relay pattern as VNC tunnel)
 * 4. Sends a final done event with token usage
 *
 * API priority:
 *   HANZO_API_KEY + zen.hanzo.ai → Zen API Gateway (OpenAI-compatible, preferred)
 *   ANTHROPIC_API_KEY + api.anthropic.com → direct Anthropic (seller's own key)
 *
 * Privacy: prompts are held in memory only during the API call, never logged to disk.
 */
import type { GatewayClient } from "../gateway/client.js";
import type { NodeHostMarketplaceConfig } from "./config.js";

export type MarketplaceProxyRequest = {
  requestId: string;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  system?: string;
};

type UsageInfo = {
  input_tokens: number;
  output_tokens: number;
};

/** Zen API Gateway — OpenAI-compatible chat completions (routes to DO-AI/Fireworks). */
const HANZO_API_URL = "https://zen.hanzo.ai/v1/chat/completions";
/** Anthropic direct API — native Messages format. */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

type ApiFormat = "openai" | "anthropic";

type ResolvedApi = {
  url: string;
  apiKey: string;
  headers: Record<string, string>;
  format: ApiFormat;
  label: string;
};

/**
 * Model name mapping for Zen API Gateway.
 * Maps Anthropic versioned model IDs and short aliases to Zen model names.
 * Zen routes these to the appropriate upstream (DO-AI, Fireworks, etc.).
 */
const HANZO_MODEL_MAP: Record<string, string> = {
  // Sonnet → zen4.1 (DO-AI: anthropic-claude-sonnet-4.6)
  "claude-sonnet-4-20250514": "zen4.1",
  "claude-sonnet-4-20250929": "zen4.1",
  "claude-sonnet-4": "zen4.1",
  "claude-sonnet-4-5": "zen4.1",
  "claude-sonnet-4-6": "zen4.1",
  "claude-3-5-sonnet-20241022": "zen4.1",
  // Opus → zen4-max (DO-AI: anthropic-claude-opus-4.6)
  "claude-opus-4-20250514": "zen4-max",
  "claude-opus-4-20250620": "zen4-max",
  "claude-opus-4": "zen4-max",
  "claude-opus-4-6": "zen4-max",
  "claude-3-opus-20240229": "zen4-max",
  // Haiku → zen4-mini (DO-AI: openai-gpt-5-nano)
  "claude-haiku-3-5-20241022": "zen4-mini",
  "claude-3-5-haiku-20241022": "zen4-mini",
  "claude-3-5-haiku": "zen4-mini",
  "claude-haiku-4-5": "zen4-mini",
  "claude-3-haiku-20240307": "zen4-mini",
};

function mapModelForHanzo(model: string): string {
  return HANZO_MODEL_MAP[model] ?? model;
}

/**
 * Resolve which API endpoint and key to use.
 *
 * Priority:
 *   1. HANZO_API_KEY or hk-* config key → zen.hanzo.ai (OpenAI format, most reliable)
 *   2. Explicit ANTHROPIC_API_KEY (sk-ant-*) → api.anthropic.com (Anthropic format)
 *   3. config.claudeApiKey (if Anthropic key) → api.anthropic.com (Anthropic format)
 */
function resolveApi(config: NodeHostMarketplaceConfig): ResolvedApi | null {
  const configKey = config.claudeApiKey;

  // 1. Hanzo API — OpenAI-compatible chat completions format (preferred).
  const hanzoKey = process.env.HANZO_API_KEY || process.env.HANZO_ACCESS_KEY;
  if (hanzoKey || (configKey && !configKey.startsWith("sk-ant-"))) {
    const key = hanzoKey ?? configKey!;
    return {
      url: process.env.HANZO_API_URL?.trim() || HANZO_API_URL,
      apiKey: key,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      format: "openai",
      label: "Hanzo API",
    };
  }

  // 2. Direct Anthropic API key from env.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && anthropicKey.startsWith("sk-ant-")) {
    return {
      url: ANTHROPIC_API_URL,
      apiKey: anthropicKey,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      format: "anthropic",
      label: "Anthropic API",
    };
  }

  // 3. Anthropic API key from config.
  if (configKey && configKey.startsWith("sk-ant-")) {
    return {
      url: ANTHROPIC_API_URL,
      apiKey: configKey,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": configKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      format: "anthropic",
      label: "Anthropic API",
    };
  }

  return null;
}

/**
 * Build the request body for the resolved API format.
 */
function buildRequestBody(
  request: MarketplaceProxyRequest,
  api: ResolvedApi,
): Record<string, unknown> {
  if (api.format === "anthropic") {
    // Anthropic Messages format
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: request.stream,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.system) {
      body.system = request.system;
    }
    return body;
  }

  // OpenAI Chat Completions format
  const messages: Array<Record<string, unknown>> = [];
  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }
  for (const msg of request.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  return {
    model: mapModelForHanzo(request.model),
    messages,
    max_tokens: request.maxTokens ?? 4096,
    stream: request.stream,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

/**
 * Handle a marketplace proxy request using the seller's API key.
 * Caller is responsible for sending the initial invoke result (ok: true).
 */
export async function handleMarketplaceProxy(
  request: MarketplaceProxyRequest,
  config: NodeHostMarketplaceConfig,
  client: GatewayClient,
): Promise<void> {
  const api = resolveApi(config);
  if (!api) {
    sendProxyError(
      client,
      request.requestId,
      "NO_API_KEY",
      "no API key configured (set HANZO_API_KEY or ANTHROPIC_API_KEY)",
    );
    return;
  }

  const startMs = Date.now();
  const body = buildRequestBody(request, api);

  try {
    const response = await fetch(api.url, {
      method: "POST",
      headers: api.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      sendProxyError(
        client,
        request.requestId,
        `HTTP_${response.status}`,
        `${api.label} ${response.status}: ${errBody.substring(0, 500)}`,
      );
      return;
    }

    // Detect HTML error pages (SPA fallback from API gateway).
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const peek = await response.text().catch(() => "");
      if (peek.trimStart().startsWith("<!") || peek.trimStart().startsWith("<html")) {
        sendProxyError(
          client,
          request.requestId,
          "INVALID_RESPONSE",
          `${api.label} returned HTML — the endpoint may not exist. URL: ${api.url}`,
        );
        return;
      }
    }

    if (request.stream) {
      if (api.format === "openai") {
        await handleOpenAIStreamingResponse(
          client,
          request.requestId,
          response,
          startMs,
          request.model,
        );
      } else {
        await handleAnthropicStreamingResponse(
          client,
          request.requestId,
          response,
          startMs,
          request.model,
        );
      }
    } else {
      if (api.format === "openai") {
        await handleOpenAINonStreamingResponse(
          client,
          request.requestId,
          response,
          startMs,
          request.model,
        );
      } else {
        await handleAnthropicNonStreamingResponse(
          client,
          request.requestId,
          response,
          startMs,
          request.model,
        );
      }
    }
  } catch (err) {
    sendProxyError(
      client,
      request.requestId,
      "FETCH_ERROR",
      `Failed to call ${api.label}: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages format handlers
// ---------------------------------------------------------------------------

async function handleAnthropicStreamingResponse(
  client: GatewayClient,
  requestId: string,
  response: Response,
  startMs: number,
  model: string,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    sendProxyError(client, requestId, "NO_BODY", "no response body");
    return;
  }

  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const data = line.substring(6);
        if (data === "[DONE]") {
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "message_start" && parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens ?? 0;
          }
          if (parsed.type === "message_delta" && parsed.usage) {
            outputTokens = parsed.usage.output_tokens ?? 0;
          }
        } catch {
          // Not all data lines are JSON.
        }

        sendProxyChunk(client, requestId, data);
      }
    }
  } finally {
    reader.releaseLock();
  }

  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

async function handleAnthropicNonStreamingResponse(
  client: GatewayClient,
  requestId: string,
  response: Response,
  startMs: number,
  model: string,
): Promise<void> {
  const text = await response.text();

  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const parsed = JSON.parse(text);
    const usage = parsed.usage as UsageInfo | undefined;
    if (usage) {
      inputTokens = usage.input_tokens ?? 0;
      outputTokens = usage.output_tokens ?? 0;
    }
  } catch {
    // If we can't parse, still send the raw response.
  }

  sendProxyChunk(client, requestId, text, true);
  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions format handlers
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI chat completion response to Anthropic Messages format
 * for consistent relay to the gateway.
 */
function openAIToAnthropicResponse(
  openaiData: Record<string, unknown>,
  requestModel: string,
): { text: string; usage: UsageInfo } {
  const choices = openaiData.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = typeof message?.content === "string" ? message.content : "";

  const usage = openaiData.usage as Record<string, number> | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  const anthropicResponse = {
    id: typeof openaiData.id === "string" ? openaiData.id : "",
    type: "message",
    role: "assistant",
    model: requestModel,
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };

  return {
    text: JSON.stringify(anthropicResponse),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

async function handleOpenAINonStreamingResponse(
  client: GatewayClient,
  requestId: string,
  response: Response,
  startMs: number,
  model: string,
): Promise<void> {
  const text = await response.text();

  let inputTokens = 0;
  let outputTokens = 0;
  let relayText = text;

  try {
    const parsed = JSON.parse(text);

    // Check for API-level errors (Hanzo API returns 200 with error in body).
    if (parsed.status === "error" || parsed.error) {
      const errMsg = parsed.msg || parsed.error?.message || "unknown API error";
      sendProxyError(client, requestId, "API_ERROR", `${errMsg}`);
      return;
    }

    const converted = openAIToAnthropicResponse(parsed, model);
    relayText = converted.text;
    inputTokens = converted.usage.input_tokens;
    outputTokens = converted.usage.output_tokens;
  } catch {
    // If we can't parse, send raw response.
  }

  sendProxyChunk(client, requestId, relayText, true);
  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

async function handleOpenAIStreamingResponse(
  client: GatewayClient,
  requestId: string,
  response: Response,
  startMs: number,
  model: string,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    sendProxyError(client, requestId, "NO_BODY", "no response body");
    return;
  }

  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  // Collect all text content for the final Anthropic-format response.
  const contentParts: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const data = line.substring(6).trim();
        if (data === "[DONE]") {
          continue;
        }

        try {
          const parsed = JSON.parse(data);

          // Check for error in stream.
          if (parsed.status === "error" || parsed.error) {
            const errMsg = parsed.msg || parsed.error?.message || "stream error";
            sendProxyError(client, requestId, "STREAM_ERROR", errMsg);
            return;
          }

          // Extract content delta from OpenAI streaming format.
          const delta = (parsed.choices as Array<Record<string, unknown>>)?.[0]?.delta as
            | Record<string, unknown>
            | undefined;
          if (delta?.content && typeof delta.content === "string") {
            contentParts.push(delta.content);
          }

          // Extract usage if present (some providers include it).
          if (parsed.usage) {
            const u = parsed.usage as Record<string, number>;
            inputTokens = u.prompt_tokens ?? inputTokens;
            outputTokens = u.completion_tokens ?? outputTokens;
          }
        } catch {
          // Non-JSON data line.
        }

        // Convert OpenAI chunk to Anthropic SSE format for relay.
        // The gateway expects Anthropic-style events.
        try {
          const parsed = JSON.parse(data);
          const delta = (parsed.choices as Array<Record<string, unknown>>)?.[0]?.delta as
            | Record<string, unknown>
            | undefined;
          if (delta?.content && typeof delta.content === "string") {
            const anthropicChunk = JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.content },
            });
            sendProxyChunk(client, requestId, anthropicChunk);
          }
        } catch {
          // Forward raw data as fallback.
          sendProxyChunk(client, requestId, data);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

// ---------------------------------------------------------------------------
// Event senders
// ---------------------------------------------------------------------------

function sendProxyChunk(
  client: GatewayClient,
  requestId: string,
  data: string,
  done?: boolean,
): void {
  try {
    void client.request("node.event", {
      event: "marketplace.proxy.chunk",
      payloadJSON: JSON.stringify({ requestId, data, done }),
    });
  } catch {
    // Best effort — gateway may be disconnected.
  }
}

function sendProxyDone(
  client: GatewayClient,
  requestId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
): void {
  try {
    void client.request("node.event", {
      event: "marketplace.proxy.done",
      payloadJSON: JSON.stringify({
        requestId,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        durationMs,
      }),
    });
  } catch {
    // Best effort.
  }
}

function sendProxyError(
  client: GatewayClient,
  requestId: string,
  code: string,
  message: string,
): void {
  try {
    void client.request("node.event", {
      event: "marketplace.proxy.error",
      payloadJSON: JSON.stringify({ requestId, code, message }),
    });
  } catch {
    // Best effort.
  }
}
