// OpenAI Completions guard-specific proof: SSRF-blocks a private IP before
// the SDK's default global fetch is ever reached.
//
// Unlike openai-completions.test.ts (which mocks the OpenAI SDK to verify
// constructor options), this test does NOT mock the SDK. It stubs
// globalThis.fetch to COUNT calls, then proves SSRF blocking intercepts the
// request before the final fetch hop — behavior only buildGuardedModelFetch
// can produce. The raw openai@6.39.1 SDK uses globalThis.fetch by default
// (when no custom fetch is supplied), so a test that only asserts the SDK
// reached globalThis.fetch would pass even without any guard wired in.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

// A private-link-local IP that the SSRF guard blocks. The model's configured
// baseUrl must be a non-trusted origin so the SSRF policy rejects it.
const SSRF_BLOCKED_MODEL = {
  id: "gpt-5.5",
  name: "GPT 5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://169.254.169.254/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("OpenAI Completions guard-specific SSRF blocking proof", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks a private-IP request before globalThis.fetch is called (guard-specific behavior)", async () => {
    // Stub globalThis.fetch to count calls — if the guard is active, the
    // SSRF check intercepts before this stub is ever reached.
    let globalFetchCalled = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        globalFetchCalled++;
        return new Response(null, { status: 500 });
      }),
    );

    // Dynamic import so the module evaluates after the stub is installed.
    const { streamOpenAICompletions } = await import("./openai-completions.js");
    const stream = streamOpenAICompletions(SSRF_BLOCKED_MODEL, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    // The lifecycle catches the SSRF error and surfaces it.
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();

    // Guard-specific assertion: buildGuardedModelFetch blocked the private-IP
    // request before globalThis.fetch was ever called. Without the guard, the
    // raw openai SDK default fetch would have called globalThis.fetch with the
    // same URL.
    expect(globalFetchCalled).toBe(0);
  });
});
