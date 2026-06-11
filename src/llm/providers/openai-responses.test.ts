import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../agents/system-prompt-cache-boundary.js";
import type { Context, Model } from "../types.js";
import { testing } from "./openai-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "newapi-local",
  baseUrl: "http://localhost:18300/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  compat: { systemPromptPlacement: "instructions" },
} satisfies Model<"openai-responses">;

describe("openai-responses provider", () => {
  it("places configured system prompts in top-level instructions", () => {
    const params = testing.buildParams(
      model,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      } satisfies Context,
      undefined,
    ) as {
      input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });
});
