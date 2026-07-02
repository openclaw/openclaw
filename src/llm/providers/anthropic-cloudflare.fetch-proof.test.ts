// Anthropic Cloudflare AI Gateway constructor guard-specific proof: the SSRF
// guard blocks a private-IP request before the SDK's default global fetch is
// ever reached. This proves `buildGuardedModelFetch` is actively wired into
// the Cloudflare branch, not just present in constructor options.
//
// Unlike anthropic.test.ts (which mocks the Anthropic SDK to verify
// constructor options), this test stubs `globalThis.fetch` to COUNT calls.
// Behavior only `buildGuardedModelFetch` can produce.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const CLOUDFLARE_ANTHROPIC_MODEL = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "cloudflare-ai-gateway",
  baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("Anthropic Cloudflare guard-specific SSRF blocking proof", () => {
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
      ...CLOUDFLARE_ANTHROPIC_MODEL,
      baseUrl: "http://169.254.169.254/v1",
    } satisfies Model<"anthropic-messages">;

    const { streamAnthropic } = await import("./anthropic.js");
    const stream = streamAnthropic(blockedModel, context, { apiKey: "sk-ant-test" });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();

    // Guard-specific: SSRF blocked the private-IP request before
    // globalThis.fetch was ever called.
    expect(globalFetchCalled).toBe(0);
  });
});
