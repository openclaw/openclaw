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
