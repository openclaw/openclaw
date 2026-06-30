// Anthropic guard-specific proof: SSRF-blocks a private IP before the SDK's
// default global fetch is ever reached.
//
// Unlike anthropic.test.ts (which mocks the @anthropic-ai/sdk to verify
// constructor options), this test does NOT mock the SDK. It stubs
// globalThis.fetch to COUNT calls, then proves SSRF blocking intercepts the
// request before the final fetch hop — behavior only buildGuardedModelFetch
// can produce. The raw @anthropic-ai/sdk uses globalThis.fetch by default
// (when no custom fetch is supplied), so a test that only asserts the SDK
// reached globalThis.fetch would pass even without any guard wired in.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

// A private-link-local IP that the SSRF guard blocks.
const SSRF_BLOCKED_MODEL = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://169.254.169.254/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("Anthropic guard-specific SSRF blocking proof", () => {
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

    const { streamAnthropic } = await import("./anthropic.js");
    const stream = streamAnthropic(SSRF_BLOCKED_MODEL, context, {
      apiKey: "sk-ant-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();

    // Guard-specific: SSRF blocked the private-IP request before
    // globalThis.fetch was ever called.
    expect(globalFetchCalled).toBe(0);
  });
});

describe("Anthropic guard real wire loopback proof (http.createServer)", () => {
  it("streams Anthropic SSE end-to-end through buildGuardedModelFetch against a real loopback server", async () => {
    const recorded: Array<{ method: string; url: string; bodyBytes: number; contentType: string }> =
      [];
    const sseEvents = [
      {
        type: "message_start",
        message: {
          id: "msg_loopback",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello from local loopback server." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 5, output_tokens: 8 },
      },
      { type: "message_stop" },
    ];
    const sseBody = sseEvents
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
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
          contentType: (req.headers["content-type"] as string) ?? "<absent>",
        });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end(sseBody);
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    try {
      const { attachModelProviderRequestTransport } =
        await import("../../agents/provider-request-config.js");
      const loopbackModel = attachModelProviderRequestTransport(
        { ...SSRF_BLOCKED_MODEL, baseUrl: `http://127.0.0.1:${port}/v1` },
        { allowPrivateNetwork: true },
      );

      const { streamAnthropic } = await import("./anthropic.js");
      const stream = streamAnthropic(loopbackModel, context, { apiKey: "sk-ant-loopback-proof" });

      const eventTypes: string[] = [];
      let textBytes = 0;
      for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === "text_delta") {
          textBytes += event.delta.length;
        }
      }
      const result = await stream.result();

      const hit = recorded[0];
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      expect(hit.method).toBe("POST");
      // @anthropic-ai/sdk appends "/v1/messages" to baseUrl, so with baseUrl
      // ".../v1" the wire URL becomes "/v1/v1/messages".
      expect(hit.url).toBe("/v1/v1/messages");
      expect(hit.bodyBytes).toBeGreaterThan(0);

      expect(eventTypes).toContain("text_delta");
      expect(textBytes).toBeGreaterThan(0);

      expect(result.stopReason).toBe("stop");
      expect(result.errorMessage).toBeUndefined();

      console.log(
        `[layer3 loopback proof] server_hits=${recorded.length} ` +
          `request_url=${hit.url} request_bytes=${hit.bodyBytes} ` +
          `content_type=${hit.contentType} ` +
          `sse_events=${eventTypes.length} text_bytes=${textBytes} ` +
          `stop_reason=${result.stopReason}`,
      );
    } finally {
      await new Promise<void>((r) => server.close(r));
    }
  });
});
