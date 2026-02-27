/**
 * Marketplace proxy — handles incoming proxy requests on the seller's node.
 *
 * When the gateway routes a buyer's request to this node, this module:
 * 1. Reads the seller's Claude API key from config/env
 * 2. Calls the Anthropic Messages API
 * 3. Streams chunks back via node.event (same relay pattern as VNC tunnel)
 * 4. Sends a final done event with token usage
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

type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Handle a marketplace proxy request using the seller's Claude API key.
 * Caller is responsible for sending the initial invoke result (ok: true).
 */
export async function handleMarketplaceProxy(
  request: MarketplaceProxyRequest,
  config: NodeHostMarketplaceConfig,
  client: GatewayClient,
): Promise<void> {
  const apiKey = config.claudeApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    sendProxyError(client, request.requestId, "NO_API_KEY", "no Claude API key configured");
    return;
  }

  const startMs = Date.now();
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

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      sendProxyError(
        client,
        request.requestId,
        `HTTP_${response.status}`,
        `Anthropic API ${response.status}: ${errBody.substring(0, 200)}`,
      );
      return;
    }

    if (request.stream) {
      await handleStreamingResponse(client, request.requestId, response, startMs, request.model);
    } else {
      await handleNonStreamingResponse(client, request.requestId, response, startMs, request.model);
    }
  } catch (err) {
    sendProxyError(
      client,
      request.requestId,
      "FETCH_ERROR",
      `Failed to call Anthropic API: ${String(err)}`,
    );
  }
}

async function handleStreamingResponse(
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
      // Keep the last partial line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const data = line.substring(6);
        if (data === "[DONE]") {
          continue;
        }

        // Extract usage from message_start and message_delta events.
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "message_start" && parsed.message?.usage) {
            inputTokens = parsed.message.usage.input_tokens ?? 0;
          }
          if (parsed.type === "message_delta" && parsed.usage) {
            outputTokens = parsed.usage.output_tokens ?? 0;
          }
        } catch {
          // Not all data lines are JSON — some are just text chunks.
        }

        // Relay the SSE data line to the gateway.
        sendProxyChunk(client, requestId, data);
      }
    }
  } finally {
    reader.releaseLock();
  }

  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

async function handleNonStreamingResponse(
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
    const usage = parsed.usage as AnthropicUsage | undefined;
    if (usage) {
      inputTokens = usage.input_tokens ?? 0;
      outputTokens = usage.output_tokens ?? 0;
    }
  } catch {
    // If we can't parse, still send the raw response.
  }

  // Send the full response as a single chunk.
  sendProxyChunk(client, requestId, text, true);
  sendProxyDone(client, requestId, model, inputTokens, outputTokens, Date.now() - startMs);
}

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
