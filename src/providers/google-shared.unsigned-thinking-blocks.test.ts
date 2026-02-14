import type { Context, Model } from "@mariozechner/pi-ai/dist/types.js";
import { convertMessages } from "@mariozechner/pi-ai/dist/providers/google-shared.js";
import { describe, expect, it } from "vitest";

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
};

const makeModel = (id: string, provider = "google-antigravity"): Model<"google-generative-ai"> =>
  ({
    id,
    name: id,
    api: "google-generative-ai",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  }) as Model<"google-generative-ai">;

const makeAssistantMessage = (
  content: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) => ({
  role: "assistant",
  content,
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
  ...overrides,
});

describe("google-shared convertMessages unsigned thinking blocks (#15681)", () => {
  it("converts unsigned thinking blocks to plain text for same provider/model", () => {
    const model = makeModel("claude-opus-4-6-thinking");
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        makeAssistantMessage([
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is my response" },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const modelTurn = contents.find((c) => c.role === "model");
    expect(modelTurn).toBeTruthy();

    const parts = modelTurn!.parts as GeminiPart[];

    // No parts should have thought: true without a valid signature
    const thoughtParts = parts.filter((p) => p.thought === true);
    expect(thoughtParts).toHaveLength(0);

    // The thinking content should appear as plain text
    const textParts = parts.filter((p) => p.text && !p.thought);
    expect(textParts.some((p) => p.text === "Let me reason about this...")).toBe(true);
    expect(textParts.some((p) => p.text === "Here is my response")).toBe(true);
  });

  it("keeps signed thinking blocks as thought:true with signature", () => {
    const model = makeModel("claude-opus-4-6-thinking");
    // Valid base64 signature (must be divisible by 4 and match base64 pattern)
    const validSignature = "dGVzdHNpZ25hdHVyZQ==";
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        makeAssistantMessage([
          {
            type: "thinking",
            thinking: "Signed reasoning",
            thinkingSignature: validSignature,
          },
          { type: "text", text: "Response" },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const modelTurn = contents.find((c) => c.role === "model");
    const parts = modelTurn!.parts as GeminiPart[];

    // Signed thinking block should be kept with thought: true
    const thoughtParts = parts.filter((p) => p.thought === true);
    expect(thoughtParts).toHaveLength(1);
    expect(thoughtParts[0].text).toBe("Signed reasoning");
    expect(thoughtParts[0].thoughtSignature).toBe(validSignature);
  });

  it("converts thinking blocks with invalid signatures to text", () => {
    const model = makeModel("claude-opus-4-6-thinking");
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        makeAssistantMessage([
          {
            type: "thinking",
            thinking: "Reasoning with bad sig",
            // Not valid base64 (odd length)
            thinkingSignature: "not-valid-base64!",
          },
          { type: "text", text: "Response" },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const modelTurn = contents.find((c) => c.role === "model");
    const parts = modelTurn!.parts as GeminiPart[];

    // Invalid signature should cause conversion to plain text
    const thoughtParts = parts.filter((p) => p.thought === true);
    expect(thoughtParts).toHaveLength(0);

    const textParts = parts.filter((p) => p.text && !p.thought);
    expect(textParts.some((p) => p.text === "Reasoning with bad sig")).toBe(true);
  });

  it("skips empty thinking blocks", () => {
    const model = makeModel("claude-opus-4-6-thinking");
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        makeAssistantMessage([
          { type: "thinking", thinking: "" },
          { type: "thinking", thinking: "   " },
          { type: "text", text: "Response" },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const modelTurn = contents.find((c) => c.role === "model");
    const parts = modelTurn!.parts as GeminiPart[];

    // Empty thinking blocks should be skipped entirely
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("Response");
  });

  it("handles multiple unsigned thinking blocks across turns", () => {
    const model = makeModel("claude-opus-4-6-thinking");
    const context = {
      messages: [
        { role: "user", content: "First question" },
        makeAssistantMessage([
          { type: "thinking", thinking: "First reasoning" },
          { type: "text", text: "First answer" },
        ]),
        { role: "user", content: "Second question" },
        makeAssistantMessage([
          { type: "thinking", thinking: "Second reasoning" },
          { type: "text", text: "Second answer" },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);

    // No thought:true parts anywhere
    const allParts = contents.flatMap((c) => (c.parts ?? []) as GeminiPart[]);
    const thoughtParts = allParts.filter((p) => p.thought === true);
    expect(thoughtParts).toHaveLength(0);

    // All thinking content should be plain text
    const textParts = allParts.filter((p) => typeof p.text === "string" && !p.thought);
    expect(textParts.some((p) => p.text === "First reasoning")).toBe(true);
    expect(textParts.some((p) => p.text === "Second reasoning")).toBe(true);
  });

  it("converts unsigned thinking from different provider to text", () => {
    const model = makeModel("gemini-2.0-flash", "google");
    const context = {
      messages: [
        { role: "user", content: "Hello" },
        makeAssistantMessage(
          [
            { type: "thinking", thinking: "Claude reasoning" },
            { type: "text", text: "Claude response" },
          ],
          {
            provider: "google-antigravity",
            model: "claude-opus-4-6-thinking",
          },
        ),
      ],
    } as unknown as Context;

    const contents = convertMessages(model, context);
    const modelTurn = contents.find((c) => c.role === "model");
    const parts = modelTurn!.parts as GeminiPart[];

    // Different model: should always convert to text
    const thoughtParts = parts.filter((p) => p.thought === true);
    expect(thoughtParts).toHaveLength(0);
  });
});
