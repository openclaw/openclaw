/**
 * Marketplace proxy — handles incoming proxy requests on the seller's node.
 *
 * When the gateway routes a buyer's request to this node, this module:
 * 1. Reads the seller's API key from config/env (HANZO_API_KEY preferred)
 * 2. Calls the Hanzo AI API (api.hanzo.ai) or Anthropic API directly
 * 3. Streams chunks back via node.event (same relay pattern as VNC tunnel)
 * 4. Sends a final done event with token usage
 *
 * API priority:
 *   HANZO_API_KEY + api.hanzo.ai/api/chat/completions → primary (Hanzo Cloud, all models)
 *   ANTHROPIC_API_KEY + api.anthropic.com/v1/messages  → explicit fallback only
 *
 * The Hanzo API uses OpenAI-compatible format; the Anthropic API uses native
 * Messages format. Responses are normalised to Anthropic SSE format before
 * relaying to the gateway so the buyer-facing endpoint is format-consistent.
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

/** Hanzo AI API — OpenAI-compatible chat completions endpoint. */
const HANZO_API_URL = "https://api.hanzo.ai/v1/chat/completions";
/** Anthropic direct API — only used when ANTHROPIC_API_KEY is explicitly set. */
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

type ApiFormat = "anthropic" | "openai";

type ResolvedApi = {
  url: string;
  apiKey: string;
  /** Header name for the API key. */
  keyHeader: string;
  /** Label for error messages. */
  label: string;
  /** Wire format for request/response bodies. */
  format: ApiFormat;
};

/**
 * Resolve which API endpoint and key to use.
 *
 * Priority:
 *   1. Explicit ANTHROPIC_API_KEY (sk-ant-*) → api.anthropic.com (Anthropic format)
 *   2. config.claudeApiKey (sk-ant-*) → api.anthropic.com (Anthropic format)
 *   3. HANZO_API_KEY (hk-*) → api.hanzo.ai (OpenAI format)
 *   4. Any other key → api.hanzo.ai (OpenAI format, best-effort)
 */
function resolveApi(config: NodeHostMarketplaceConfig): ResolvedApi | null {
  // 1. Real Anthropic API key (from env or config) — native format.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && anthropicKey.startsWith("sk-ant-")) {
    return {
      url: ANTHROPIC_API_URL,
      apiKey: anthropicKey,
      keyHeader: "x-api-key",
      label: "Anthropic API",
      format: "anthropic",
    };
  }
  const configKey = config.claudeApiKey;
  if (configKey && configKey.startsWith("sk-ant-")) {
    return {
      url: ANTHROPIC_API_URL,
      apiKey: configKey,
      keyHeader: "x-api-key",
      label: "Anthropic API",
      format: "anthropic",
    };
  }

  // 2. Hanzo API (hk- key or JWT) → OpenAI-compatible endpoint.
  const hanzoKey = configKey || process.env.HANZO_API_KEY || process.env.HANZO_ACCESS_KEY;
  if (hanzoKey) {
    return {
      url: process.env.HANZO_API_URL?.trim() || HANZO_API_URL,
      apiKey: hanzoKey,
      keyHeader: "Authorization",
      label: "Hanzo API",
      format: "openai",
    };
  }

  return null;
}

/**
 * Build the request body and headers for the resolved API.
 */
function buildRequest(
  api: ResolvedApi,
  request: MarketplaceProxyRequest,
): { body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (api.format === "anthropic") {
    // Anthropic Messages API format.
    headers[api.keyHeader] = api.apiKey;
    headers["anthropic-version"] = API_VERSION;

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
    return { body: JSON.stringify(body), headers };
  }

  // OpenAI chat completions format.
  headers[api.keyHeader] = `Bearer ${api.apiKey}`;

  // Convert: Anthropic system (top-level) → OpenAI system message.
  const messages: Array<{ role: string; content: unknown }> = [];
  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push(...request.messages);

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens ?? 4096,
    stream: request.stream,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  return { body: JSON.stringify(body), headers };
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
      "no API key configured (set HANZO_API_KEY or claudeApiKey in marketplace config)",
    );
    return;
  }

  const startMs = Date.now();
  const { body, headers } = buildRequest(api, request);

  try {
    const response = await fetch(api.url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      sendProxyError(
        client,
        request.requestId,
        `HTTP_${response.status}`,
        `${api.label} ${response.status}: ${errBody.substring(0, 200)}`,
      );
      return;
    }

    // Detect non-JSON responses (e.g. SPA HTML from a non-functional API proxy).
    // Note: some API gateways (KrakenD) return text/plain for JSON responses.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const peek = await response.text().catch(() => "");
      if (peek.trimStart().startsWith("<!") || peek.trimStart().startsWith("<html")) {
        sendProxyError(
          client,
          request.requestId,
          "INVALID_RESPONSE",
          `${api.label} returned HTML response. The API endpoint may not be operational.`,
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
// Anthropic format handlers (native /v1/messages SSE)
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
// OpenAI format handlers (Hanzo API /api/chat/completions)
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI streaming response to Anthropic SSE events for the buyer.
 *
 * OpenAI SSE: `data: {"choices":[{"delta":{"content":"..."}}]}`
 * Anthropic SSE: `message_start`, `content_block_delta`, `message_delta`
 *
 * We synthesize Anthropic-format events so the buyer-facing relay is consistent
 * regardless of which backend the seller uses.
 */
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
  let sentStart = false;

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

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        // Extract usage if present (OpenAI includes it in the final chunk).
        const usage = parsed.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }

        // Convert OpenAI delta to Anthropic SSE events.
        const choices = parsed.choices as
          | Array<{ delta?: { content?: string; role?: string }; finish_reason?: string | null }>
          | undefined;

        if (!sentStart) {
          // Emit synthetic message_start.
          sentStart = true;
          sendProxyChunk(
            client,
            requestId,
            JSON.stringify({
              type: "message_start",
              message: {
                id: typeof parsed.id === "string" ? parsed.id : requestId,
                type: "message",
                role: "assistant",
                model,
                content: [],
                usage: { input_tokens: inputTokens, output_tokens: 0 },
              },
            }),
          );
          sendProxyChunk(
            client,
            requestId,
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
          );
        }

        if (choices?.[0]?.delta?.content) {
          sendProxyChunk(
            client,
            requestId,
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: choices[0].delta.content },
            }),
          );
        }

        if (choices?.[0]?.finish_reason) {
          sendProxyChunk(
            client,
            requestId,
            JSON.stringify({ type: "content_block_stop", index: 0 }),
          );
          sendProxyChunk(
            client,
            requestId,
            JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: outputTokens },
            }),
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

/**
 * Convert an OpenAI non-streaming response to Anthropic Messages format.
 */
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
  let anthropicResponse: string;

  try {
    const parsed = JSON.parse(text);
    const usage = parsed.usage as
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    if (usage) {
      inputTokens = usage.prompt_tokens ?? 0;
      outputTokens = usage.completion_tokens ?? 0;
    }

    // Convert OpenAI response → Anthropic Messages response.
    const choices = parsed.choices as
      | Array<{ message?: { content?: string; role?: string }; finish_reason?: string }>
      | undefined;
    const content = choices?.[0]?.message?.content ?? "";

    anthropicResponse = JSON.stringify({
      id: String(parsed.id ?? requestId),
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  } catch {
    // If we can't parse, send the raw response as-is.
    anthropicResponse = text;
  }

  sendProxyChunk(client, requestId, anthropicResponse, true);
  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

// ---------------------------------------------------------------------------
// Event helpers
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
