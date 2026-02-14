import type { Api, Message, Model } from "@mariozechner/pi-ai/dist/types.js";
import { transformMessages } from "@mariozechner/pi-ai/dist/providers/transform-messages.js";
import { describe, expect, it } from "vitest";

const makeModel = <T extends Api>(api: T, provider: string, id: string): Model<T> =>
  ({
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<T>;

describe("transformMessages unsigned thinking blocks (#15681)", () => {
  it("converts unsigned thinking blocks to text even when isSameModel", () => {
    const model = makeModel(
      "google-generative-ai",
      "google-antigravity",
      "claude-opus-4-6-thinking",
    );
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Hi there!" },
        ],
        api: "google-generative-ai",
        provider: "google-antigravity",
        model: "claude-opus-4-6-thinking",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      } as unknown as Message,
    ];

    const result = transformMessages(messages, model);
    const assistant = result.find((m) => m.role === "assistant") as Extract<
      Message,
      { role: "assistant" }
    >;

    // Unsigned thinking block should be converted to text, not kept as type "thinking"
    const thinkingBlocks = assistant.content.filter((b: { type: string }) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(0);

    const textBlocks = assistant.content.filter((b: { type: string }) => b.type === "text");
    expect(textBlocks).toHaveLength(2);
    expect((textBlocks[0] as { text: string }).text).toBe("Let me think about this...");
    expect((textBlocks[1] as { text: string }).text).toBe("Hi there!");
  });

  it("keeps signed thinking blocks for same model", () => {
    const model = makeModel(
      "google-generative-ai",
      "google-antigravity",
      "claude-opus-4-6-thinking",
    );
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me think...",
            thinkingSignature: "dGVzdHNpZw==",
          },
          { type: "text", text: "Hi!" },
        ],
        api: "google-generative-ai",
        provider: "google-antigravity",
        model: "claude-opus-4-6-thinking",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      } as unknown as Message,
    ];

    const result = transformMessages(messages, model);
    const assistant = result.find((m) => m.role === "assistant") as Extract<
      Message,
      { role: "assistant" }
    >;

    // Signed thinking blocks should be preserved
    const thinkingBlocks = assistant.content.filter((b: { type: string }) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
    expect((thinkingBlocks[0] as { thinking: string }).thinking).toBe("Let me think...");
  });

  it("skips empty unsigned thinking blocks for same model", () => {
    const model = makeModel(
      "google-generative-ai",
      "google-antigravity",
      "claude-opus-4-6-thinking",
    );
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "   " },
          { type: "text", text: "Hi!" },
        ],
        api: "google-generative-ai",
        provider: "google-antigravity",
        model: "claude-opus-4-6-thinking",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      } as unknown as Message,
    ];

    const result = transformMessages(messages, model);
    const assistant = result.find((m) => m.role === "assistant") as Extract<
      Message,
      { role: "assistant" }
    >;

    // Empty thinking blocks should be skipped entirely
    expect(assistant.content).toHaveLength(1);
    expect((assistant.content[0] as { type: string }).type).toBe("text");
  });

  it("converts unsigned thinking blocks to text for different model", () => {
    const model = makeModel("google-generative-ai", "google", "gemini-2.0-flash");
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Some reasoning" },
          { type: "text", text: "Response" },
        ],
        api: "google-generative-ai",
        provider: "google-antigravity",
        model: "claude-opus-4-6-thinking",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      } as unknown as Message,
    ];

    const result = transformMessages(messages, model);
    const assistant = result.find((m) => m.role === "assistant") as Extract<
      Message,
      { role: "assistant" }
    >;

    // Different model: unsigned thinking blocks should still be converted to text
    const thinkingBlocks = assistant.content.filter((b: { type: string }) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(0);

    const textBlocks = assistant.content.filter((b: { type: string }) => b.type === "text");
    expect(textBlocks).toHaveLength(2);
    expect((textBlocks[0] as { text: string }).text).toBe("Some reasoning");
  });
});
