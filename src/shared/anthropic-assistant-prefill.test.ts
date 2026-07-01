import { describe, expect, it } from "vitest";
import type { Context, Model } from "../llm/types.js";
import { prepareClaudeSonnet5RequestContext } from "./anthropic-assistant-prefill.js";

const sonnet5 = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} satisfies Model<"anthropic-messages">;

function contextWithAssistantContent(content: unknown): Context {
  return {
    messages: [
      { role: "user", content: "hello", timestamp: 0 },
      { role: "assistant", content } as Context["messages"][number],
    ],
  };
}

describe("prepareClaudeSonnet5RequestContext", () => {
  it("removes trailing text prefills", () => {
    const prepared = prepareClaudeSonnet5RequestContext(
      sonnet5,
      contextWithAssistantContent([{ type: "text", text: "{" }]),
    );

    expect(prepared.messages).toEqual([{ role: "user", content: "hello", timestamp: 0 }]);
  });

  it("preserves trailing assistant tool-use turns", () => {
    const context = contextWithAssistantContent([
      { type: "toolCall", id: "toolu_1", name: "lookup", arguments: {} },
    ]);

    expect(prepareClaudeSonnet5RequestContext(sonnet5, context)).toBe(context);
  });

  it("leaves other model families unchanged", () => {
    const context = contextWithAssistantContent([{ type: "text", text: "{" }]);

    expect(
      prepareClaudeSonnet5RequestContext({ ...sonnet5, id: "claude-sonnet-4-6" }, context),
    ).toBe(context);
  });
});
