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
