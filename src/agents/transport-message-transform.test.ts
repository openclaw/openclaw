import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  normalizeAssistantContent,
  transformTransportMessages,
} from "./transport-message-transform.js";

function makeModel(overrides?: Partial<Model<Api>>): Model<Api> {
  return {
    id: "test-model",
    provider: "test-provider",
    api: "anthropic-messages",
    input: ["text"],
    ...overrides,
  } as Model<Api>;
}

function makeAssistantMessage(
  content: unknown,
  overrides?: Record<string, unknown>,
): Context["messages"][number] {
  return {
    role: "assistant",
    content,
    provider: "minimax-portal",
    api: "anthropic-messages",
    model: "MiniMax-M2.7-highspeed",
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    ...overrides,
  } as unknown as Context["messages"][number];
}

describe("normalizeAssistantContent", () => {
  it("returns array content unchanged", () => {
    const blocks = [{ type: "text", text: "hello" }];
    expect(normalizeAssistantContent(blocks)).toBe(blocks);
  });

  it("wraps non-empty string content in a text block", () => {
    expect(normalizeAssistantContent("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(normalizeAssistantContent("")).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(normalizeAssistantContent(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(normalizeAssistantContent(undefined)).toEqual([]);
  });

  it("JSON-stringifies unknown types into a text block", () => {
    expect(normalizeAssistantContent(42)).toEqual([{ type: "text", text: "42" }]);
    expect(normalizeAssistantContent(true)).toEqual([{ type: "text", text: "true" }]);
    expect(normalizeAssistantContent({ key: "val" })).toEqual([
      { type: "text", text: '{"key":"val"}' },
    ]);
  });
});

describe("transformTransportMessages with string content", () => {
  it("normalizes string content from assistant messages without crashing", () => {
    const model = makeModel();
    const messages: Context["messages"] = [
      {
        role: "user",
        content: "hi",
        timestamp: Date.now(),
      } as Context["messages"][number],
      makeAssistantMessage("Hello! How can I help you?"),
    ];

    const result = transformTransportMessages(messages, model);

    expect(result).toHaveLength(2);
    const assistant = result[1];
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray((assistant as { content: unknown }).content)).toBe(true);
    expect((assistant as { content: Array<{ type: string; text: string }> }).content).toEqual([
      { type: "text", text: "Hello! How can I help you?" },
    ]);
  });

  it("normalizes null content from assistant messages", () => {
    const model = makeModel();
    const messages: Context["messages"] = [makeAssistantMessage(null)];

    const result = transformTransportMessages(messages, model);

    expect(result).toHaveLength(1);
    const assistant = result[0];
    expect(Array.isArray((assistant as { content: unknown }).content)).toBe(true);
    expect((assistant as { content: unknown[] }).content).toEqual([]);
  });

  it("preserves normal array content unchanged", () => {
    const model = makeModel({
      provider: "minimax-portal",
      api: "anthropic-messages",
      id: "MiniMax-M2.7-highspeed",
    });
    const textBlock = { type: "text" as const, text: "response text" };
    const messages: Context["messages"] = [makeAssistantMessage([textBlock])];

    const result = transformTransportMessages(messages, model);

    expect(result).toHaveLength(1);
    const assistant = result[0] as { content: Array<{ type: string; text: string }> };
    expect(assistant.content).toEqual([textBlock]);
  });
});
