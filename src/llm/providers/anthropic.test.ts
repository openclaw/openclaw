import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const anthropicMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      anthropicMockState.configs.push(config);
    }
  },
}));

import { streamAnthropic } from "./anthropic.js";

describe("Anthropic provider", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
  });

  it("keeps Cloudflare AI Gateway upstream provider auth on the Anthropic API key", async () => {
    const model = {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "cloudflare-ai-gateway",
      api: "anthropic-messages",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 4096,
      headers: {
        "cf-aig-authorization": "Bearer gateway-token",
      },
    } satisfies Model<"anthropic-messages">;
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } satisfies Context;

    streamAnthropic(model, context, {
      apiKey: "sk-ant-provider",
    });

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
      defaultHeaders?: Record<string, string | null>;
    };

    expect(config.apiKey).toBe("sk-ant-provider");
    expect(config.authToken).toBeNull();
    expect(config.defaultHeaders?.["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer gateway-token");
  });
});
