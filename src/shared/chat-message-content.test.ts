import { describe, expect, it } from "vitest";
import {
  extractAssistantTextForPhase,
  extractAssistantVisibleText,
  extractFirstTextBlock,
  isTranscriptOnlyOpenClawAssistantMessage,
  resolveAssistantMessagePhase,
} from "./chat-message-content.js";

describe("shared/chat-message-content", () => {
  it("extracts the first text block from array content", () => {
    expect(
      extractFirstTextBlock({
        content: [{ text: "hello" }, { text: "world" }],
      }),
    ).toBe("hello");
  });

  it("returns plain string content", () => {
    expect(
      extractFirstTextBlock({
        content: "hello from string content",
      }),
    ).toBe("hello from string content");
  });

  it("preserves empty-string text in the first block", () => {
    expect(
      extractFirstTextBlock({
        content: [{ text: "" }, { text: "later" }],
      }),
    ).toBe("");
  });

  it("only considers the first content block even if later blocks have text", () => {
    expect(
      extractFirstTextBlock({
        content: [null, { text: "later" }],
      }),
    ).toBeUndefined();
    expect(
      extractFirstTextBlock({
        content: [{ type: "image" }, { text: "later" }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for missing, empty, or non-text content", () => {
    expect(extractFirstTextBlock(null)).toBeUndefined();
    expect(extractFirstTextBlock({ content: [] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: [{ type: "image" }] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: ["hello"] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: [{ text: 1 }, { text: "later" }] })).toBeUndefined();
  });
});

describe("extractAssistantVisibleText", () => {
  it("preserves boundary spacing when joining adjacent final_answer text blocks", () => {
    expect(
      extractAssistantTextForPhase(
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hi ",
              textSignature: JSON.stringify({ v: 1, id: "msg_final_1", phase: "final_answer" }),
            },
            {
              type: "text",
              text: "there",
              textSignature: JSON.stringify({ v: 1, id: "msg_final_2", phase: "final_answer" }),
            },
          ],
        },
        { phase: "final_answer", joinWith: "" },
      ),
    ).toBe("Hi there");
  });

  it("prefers final_answer text over commentary text", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "thinking like caveman",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Actual final answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
          },
        ],
      }),
    ).toBe("Actual final answer");
  });

  it("does not fall back to commentary-only text", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "thinking like caveman",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not fall back to unphased legacy text when final_answer is empty", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [
          { type: "text", text: "Legacy answer" },
          {
            type: "text",
            text: "   ",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("falls back to unphased legacy text", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [{ type: "text", text: "Legacy answer" }],
      }),
    ).toBe("Legacy answer");
  });

  it("does not mix unphased legacy text into final_answer output", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        phase: "final_answer",
        content: [
          { type: "text", text: "Legacy answer" },
          {
            type: "text",
            text: "Actual final answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
          },
        ],
      }),
    ).toBe("Actual final answer");
  });
});

describe("resolveAssistantMessagePhase", () => {
  it("prefers the top-level assistant phase when present", () => {
    expect(resolveAssistantMessagePhase({ role: "assistant", phase: "commentary" })).toBe(
      "commentary",
    );
  });

  it("resolves a single explicit phase from textSignature metadata", () => {
    expect(
      resolveAssistantMessagePhase({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Actual final answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
          },
        ],
      }),
    ).toBe("final_answer");
  });

  it("returns undefined when text blocks contain mixed explicit phases", () => {
    expect(
      resolveAssistantMessagePhase({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Working...",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("isTranscriptOnlyOpenClawAssistantMessage", () => {
  it("returns true for delivery-mirror assistant messages", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "hey" }],
      }),
    ).toBe(true);
  });

  it("returns true for gateway-injected assistant messages", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "openclaw",
        model: "gateway-injected",
        content: [{ type: "text", text: "synthetic" }],
      }),
    ).toBe(true);
  });

  it("trims whitespace around provider and model before comparing", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "  openclaw  ",
        model: " delivery-mirror ",
      }),
    ).toBe(true);
  });

  it("returns false for real assistant messages from real providers", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hey" }],
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        content: [{ type: "text", text: "hey" }],
      }),
    ).toBe(false);
  });

  it("returns false when provider is openclaw but model is not a transcript-only marker", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "openclaw",
        model: "some-other-model",
      }),
    ).toBe(false);
  });

  it("returns false for user messages even when shaped like a transcript-only marker", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "user",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "hi" }],
      }),
    ).toBe(false);
  });

  it("returns false for tool, system, and other roles", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "tool",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "system",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    ).toBe(false);
  });

  it("returns false for null, undefined, and non-object inputs", () => {
    expect(isTranscriptOnlyOpenClawAssistantMessage(null)).toBe(false);
    expect(isTranscriptOnlyOpenClawAssistantMessage(undefined)).toBe(false);
    expect(isTranscriptOnlyOpenClawAssistantMessage("delivery-mirror")).toBe(false);
    expect(isTranscriptOnlyOpenClawAssistantMessage(42)).toBe(false);
  });

  it("returns false when provider or model fields are missing or non-string", () => {
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        model: "delivery-mirror",
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: "openclaw",
      }),
    ).toBe(false);
    expect(
      isTranscriptOnlyOpenClawAssistantMessage({
        role: "assistant",
        provider: 123,
        model: "delivery-mirror",
      }),
    ).toBe(false);
  });
});
