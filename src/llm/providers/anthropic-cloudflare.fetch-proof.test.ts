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

const CONTEXT = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

describe("Anthropic Cloudflare guarded fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks private-network requests before the Anthropic SDK reaches global fetch", async () => {
    const globalFetch = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", globalFetch);

    const { streamAnthropic } = await import("./anthropic.js");
    const stream = streamAnthropic(
      {
        ...CLOUDFLARE_ANTHROPIC_MODEL,
        baseUrl: "http://169.254.169.254/v1",
      },
      CONTEXT,
      { apiKey: "sk-ant-test" },
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBeTruthy();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
