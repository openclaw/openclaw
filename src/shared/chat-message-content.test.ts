// Chat message content tests cover visible text extraction from message parts.
import { describe, expect, it } from "vitest";
import {
  extractAssistantTextForPhase,
  extractAssistantVisibleText,
  extractFirstTextBlock,
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
              textSignature: JSON.stringify({
                v: 1,
                id: "msg_final_1",
                phase: "final_answer",
              }),
            },
            {
              type: "text",
              text: "there",
              textSignature: JSON.stringify({
                v: 1,
                id: "msg_final_2",
                phase: "final_answer",
              }),
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
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_commentary",
              phase: "commentary",
            }),
          },
          {
            type: "text",
            text: "Actual final answer",
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_final",
              phase: "final_answer",
            }),
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
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_commentary",
              phase: "commentary",
            }),
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
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_final",
              phase: "final_answer",
            }),
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

  it("extracts persisted Responses output_text blocks as assistant-visible text", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [{ type: "output_text", text: "Persisted assistant answer" }],
      }),
    ).toBe("Persisted assistant answer");
  });

  it("extracts persisted Responses assistant input_text blocks", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [{ type: "input_text", text: "Persisted assistant input" }],
      }),
    ).toBe("Persisted assistant input");
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
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_final",
              phase: "final_answer",
            }),
          },
        ],
      }),
    ).toBe("Actual final answer");
  });

  // Regression: openclaw/openclaw#96849 -- Discord main-session deliveries
  // leaked model thinking content because providers like MiniMax-M3 emit
  // internal monologue as plain `type: "text"` blocks interleaved with
  // `type: "thinking"` blocks (no phase metadata). Unphased extraction used
  // to join every text block and concatenate the monologue with the final
  // answer.
  it("drops unphased text blocks emitted before a later thinking block", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Gabe is asking me to confirm..." },
          { type: "thinking", thinking: "Excellent! Key info..." },
          {
            type: "text",
            text: "All done. Let me give Gabe a clean status update. Status: \u2705 patch applied, \u2705 memory committed. Let me give Gabe a tight summary. Also, this message is the verification test \u2014 if Gabe sees thinking in my reply, the patch failed.",
          },
          { type: "thinking", thinking: "Let me give Gabe a tight summary..." },
          {
            type: "thinking",
            thinking: "Also, this message is the verification test...",
          },
          {
            type: "text",
            text: "Done. Here's the final status: \u2705 patch applied, \u2705 memory committed.",
          },
        ],
      }),
    ).toBe("Done. Here's the final status: \u2705 patch applied, \u2705 memory committed.");
  });

  it("keeps unphased final text even when a trailing thinking block follows", () => {
    // text -> thinking only (no later text) is the post-answer-reflection
    // shape some providers emit. Do NOT drop the text in that case.
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Plan: write a clean answer." },
          { type: "text", text: "Here's the answer." },
          { type: "thinking", thinking: "Postmortem: that was concise." },
        ],
      }),
    ).toBe("Here's the answer.");
  });

  it("keeps all text when no thinking blocks are present", () => {
    expect(
      extractAssistantVisibleText({
        role: "assistant",
        content: [
          { type: "text", text: "First sentence." },
          { type: "text", text: "Second sentence." },
        ],
      }),
    ).toBe("First sentence.\nSecond sentence.");
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
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_final",
              phase: "final_answer",
            }),
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
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_commentary",
              phase: "commentary",
            }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_final",
              phase: "final_answer",
            }),
          },
        ],
      }),
    ).toBeUndefined();
  });
});
