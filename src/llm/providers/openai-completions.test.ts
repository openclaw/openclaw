import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createModel(maxTokens: number): Model<"openai-completions"> {
  return {
    id: "custom-model",
    name: "Custom Model",
    api: "openai-completions",
    provider: "custom-openai-compatible",
    baseUrl: "https://third-party.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens,
  };
}

describe("OpenAI-compatible completions params", () => {
  it("clamps requested max tokens to the model output cap", async () => {
    let capturedMaxTokens: unknown;
    const stream = streamOpenAICompletions(createModel(32_000), context, {
      apiKey: "sk-test",
      maxTokens: 200_000,
      onPayload(payload) {
        capturedMaxTokens = (payload as { max_completion_tokens?: unknown }).max_completion_tokens;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedMaxTokens).toBe(32_000);
  });

  it("forwards simple stop sequences to request params", async () => {
    let capturedStop: unknown;
    const stream = streamSimpleOpenAICompletions(createModel(32_000), context, {
      apiKey: "sk-test",
      stop: ["STOP"],
      onPayload(payload) {
        capturedStop = (payload as { stop?: unknown }).stop;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedStop).toEqual(["STOP"]);
  });
});
