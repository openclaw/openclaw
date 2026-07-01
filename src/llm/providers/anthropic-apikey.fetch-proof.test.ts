// Anthropic API-key constructor guard-specific proof: SSRF-blocks a
// private IP before the SDK's default global fetch is ever reached, then
// streams Anthropic SSE end-to-end through buildGuardedModelFetch against
// a real local HTTP server.
//
// Unlike anthropic.test.ts (which mocks the Anthropic SDK to verify
// constructor options), this test does NOT mock the SDK for the SSRF
// block or loopback proof — it stubs globalThis.fetch to COUNT calls and
// proves the guard intercepts the request before the final fetch hop.
// Behavior only buildGuardedModelFetch can produce.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

// A private-link-local IP that the SSRF guard blocks.
const SSRF_BLOCKED_APIKEY_MODEL = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("Anthropic API-key guard-specific SSRF blocking proof", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks a private-IP request before globalThis.fetch is called (guard-specific behavior)", async () => {
    let globalFetchCalled = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        globalFetchCalled++;
        return new Response(null, { status: 500 });
      }),
    );

    // Override the model baseUrl to a private link-local IP that the guard blocks.
    const blockedModel = {
      ...SSRF_BLOCKED_APIKEY_MODEL,
      baseUrl: "http://169.254.169.254/v1",
    } satisfies Model<"anthropic-messages">;

    const { streamAnthropic } = await import("./anthropic.js");
    const stream = streamAnthropic(blockedModel, context, { apiKey: "sk-ant-api03-test" });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();

    // Guard-specific: SSRF blocked the private-IP request before
    // globalThis.fetch was ever called.
    expect(globalFetchCalled).toBe(0);
  });
});

describe("Anthropic API-key guard real wire loopback proof (http.createServer)", () => {
  it("streams Anthropic SSE end-to-end through buildGuardedModelFetch against a real loopback server", async () => {
    const recorded: Array<{
      method: string;
      url: string;
      bodyBytes: number;
      authorization: string;
      contentType: string;
      xApiKey?: string;
    }> = [];
    const sseEvents: Array<Record<string, unknown>> = [
      {
        type: "message_start",
        message: {
          id: "msg_loopback",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 9, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello from local API-key Anthropic loopback." },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      },
      {
        type: "message_stop",
      },
    ];
    const sseBody = sseEvents
      .map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        recorded.push({
          method: req.method ?? "?",
          url: req.url ?? "?",
          bodyBytes: body.byteLength,
          authorization: (req.headers.authorization as string) ?? "<absent>",
          contentType: (req.headers["content-type"] as string) ?? "<absent>",
          xApiKey: req.headers["x-api-key"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(sseBody);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const { attachModelProviderRequestTransport } =
        await import("../../agents/provider-request-config.js");
      const loopbackModel = attachModelProviderRequestTransport(
        {
          ...SSRF_BLOCKED_APIKEY_MODEL,
          baseUrl: `http://127.0.0.1:${port}`,
        },
        { allowPrivateNetwork: true },
      );

      const { streamAnthropic } = await import("./anthropic.js");
      const stream = streamAnthropic(loopbackModel, context, {
        apiKey: "sk-ant-api03-loopback-proof",
      });

      let textBytes = 0;
      for await (const event of stream) {
        if (event.type === "text_delta") {
          textBytes += event.delta.length;
        }
      }
      const result = await stream.result();

      const hit = recorded[0];
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      expect(hit.method).toBe("POST");
      // Anthropic SDK appends "/v1/messages" to baseUrl, so with
      // baseUrl "http://127.0.0.1:PORT" the wire URL is "/v1/messages".
      expect(hit.url).toBe("/v1/messages");
      expect(hit.bodyBytes).toBeGreaterThan(0);
      // API-key constructor sets apiKey and authToken:null, which the SDK
      // sends as the `x-api-key` header.
      expect(hit.xApiKey).toBe("sk-ant-api03-loopback-proof");
      expect(hit.authorization).toBe("<absent>");
      expect(hit.contentType).toBe("application/json");

      expect(textBytes).toBeGreaterThan(0);
      expect(result.stopReason).toBe("stop");
      expect(result.errorMessage).toBeUndefined();

      console.log(
        `[layer3 loopback proof] server_hits=${recorded.length} ` +
          `request_url=${hit.url} request_bytes=${hit.bodyBytes} ` +
          `content_type=${hit.contentType} ` +
          `text_bytes=${textBytes} ` +
          `stop_reason=${result.stopReason}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
