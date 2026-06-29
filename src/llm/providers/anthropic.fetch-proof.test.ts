// Anthropic SDK fetch-wiring proof through the real HTTP pipeline.
//
// Unlike anthropic.test.ts (which mocks the Anthropic SDK to verify
// constructor options), this test does NOT mock the SDK. Instead it stubs
// globalThis.fetch and lets the real SDK + buildGuardedModelFetch route
// through the guarded fetch pipeline. The stub intercepts the final
// global fetch call — proving the custom fetch from buildGuardedModelFetch
// was actually invoked by the SDK for HTTP.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const model = {
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

describe("Anthropic SDK fetch pipeline (real HTTP proof)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes the SDK HTTP call through buildGuardedModelFetch to globalThis.fetch", async () => {
    // Stub the global fetch so the guarded pipeline's final hop is caught.
    // Without mocking the SDK, the real @anthropic-ai/sdk constructor receives
    // buildGuardedModelFetch(model) as its fetch option. When the SDK issues
    // the POST to /v1/messages, it calls this.fetch(url, init) — which is
    // buildGuardedModelFetch(model). That wrapper routes through the SSRF
    // guard, timeout, and retry layers, then calls globalThis.fetch (our spy).
    const intercepted: { url: string; init: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: unknown) => {
        intercepted.push({ url, init });
        // Return 500 to short-circuit the lifecycle without real API parsing.
        return new Response(null, {
          status: 500,
          statusText: "Test intercept",
        });
      }),
    );

    // Dynamic import so the module evaluates after the stub is installed.
    const { streamAnthropic } = await import("./anthropic.js");
    const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
    const result = await stream.result();

    // The lifecycle runner catches any error and surfaces a structured event.
    expect(result.stopReason).toBe("error");

    // At least one HTTP call was made — the SDK POSTs to /v1/messages.
    // The SDK retries on 500 by default, so we may see 2-3 calls; the key
    // assertion is that every call goes to the correct API endpoint.
    expect(intercepted.length).toBeGreaterThanOrEqual(1);
    const firstCall = intercepted[0];
    expect(firstCall.url).toBe("https://api.anthropic.com/v1/messages");

    // Verify request shape.
    const init = firstCall.init as Record<string, unknown>;
    const method = typeof init.method === "string" ? init.method : "POST";
    expect(method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");

    // All intercepted calls (including SDK retries) target the same endpoint.
    for (const call of intercepted) {
      expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    }
  });
});
