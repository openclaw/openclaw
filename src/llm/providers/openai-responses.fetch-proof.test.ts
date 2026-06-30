// OpenAI Responses guard-specific proof: SSRF-blocks a private IP before
// the SDK's default global fetch is ever reached.
//
// Unlike openai-responses.test.ts (which mocks the OpenAI SDK to verify
// constructor options), this test does NOT mock the SDK. It stubs
// globalThis.fetch to COUNT calls, then proves SSRF blocking intercepts the
// request before the final fetch hop — behavior only buildGuardedModelFetch
// can produce. The raw openai SDK uses globalThis.fetch by default (when no
// custom fetch is supplied), so a test that only asserts the SDK reached
// globalThis.fetch would pass even without any guard wired in.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

// A private-link-local IP that the SSRF guard blocks.
const SSRF_BLOCKED_MODEL = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://169.254.169.254/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("OpenAI Responses guard-specific SSRF blocking proof", () => {
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

    const { streamOpenAIResponses } = await import("./openai-responses.js");
    const stream = streamOpenAIResponses(SSRF_BLOCKED_MODEL, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();

    // Guard-specific: SSRF blocked the private-IP request before
    // globalThis.fetch was ever called.
    expect(globalFetchCalled).toBe(0);
  });
});

describe("OpenAI Responses guard real wire loopback proof (http.createServer)", () => {
  it("streams OpenAI Responses SSE end-to-end through buildGuardedModelFetch against a real loopback server", async () => {
    const recorded: Array<{
      method: string;
      url: string;
      bodyBytes: number;
      authorization: string;
      contentType: string;
    }> = [];
    const sseEvents: Array<Record<string, unknown>> = [
      {
        type: "response.created",
        response: {
          id: "resp_loopback",
          object: "response",
          model: "gpt-5.5",
          status: "in_progress",
          output: [],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_loopback",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_loopback",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_loopback",
        output_index: 0,
        content_index: 0,
        delta: "Hello from local OpenAI Responses loopback.",
      },
      {
        type: "response.output_text.done",
        item_id: "msg_loopback",
        output_index: 0,
        content_index: 0,
        text: "Hello from local OpenAI Responses loopback.",
      },
      {
        type: "response.content_part.done",
        item_id: "msg_loopback",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "Hello from local OpenAI Responses loopback.",
          annotations: [],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_loopback",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Hello from local OpenAI Responses loopback.",
              annotations: [],
            },
          ],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_loopback",
          object: "response",
          model: "gpt-5.5",
          status: "completed",
          usage: { input_tokens: 9, output_tokens: 7, total_tokens: 16 },
          output: [
            {
              id: "msg_loopback",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Hello from local OpenAI Responses loopback.",
                  annotations: [],
                },
              ],
            },
          ],
        },
      },
    ];
    const sseBody =
      sseEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

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
        { ...SSRF_BLOCKED_MODEL, baseUrl: `http://127.0.0.1:${port}/v1` },
        { allowPrivateNetwork: true },
      );

      const { streamOpenAIResponses } = await import("./openai-responses.js");
      const stream = streamOpenAIResponses(loopbackModel, context, {
        apiKey: "sk-openai-loopback-proof",
      });

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
      // openai SDK appends "/responses" to baseUrl, so with baseUrl ".../v1"
      // the wire URL becomes "/v1/responses".
      expect(hit.url).toBe("/v1/responses");
      expect(hit.bodyBytes).toBeGreaterThan(0);
      expect(hit.authorization).toBe("Bearer sk-openai-loopback-proof");
      expect(hit.contentType).toBe("application/json");

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
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
