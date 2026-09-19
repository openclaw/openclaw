// Chat message content tests cover visible text extraction from message parts.
import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantTextForPhase,
  extractAssistantPhaseText,
  extractFirstTextBlock,
  readAssistantTextBlocksForPhase,
  isGeneratedMiniMaxAssistantCommentaryId,
  isGeneratedAssistantTextSignatureId,
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "./chat-message-content.js";

describe("generated assistant text signature ids", () => {
  it("recognizes OpenClaw stream-reconciliation identities and rejects provider ids", () => {
    expect(isGeneratedAssistantTextSignatureId("commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(
      isGeneratedAssistantTextSignatureId("minimax-commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe(true);
    expect(isGeneratedAssistantTextSignatureId("final-answer-1-bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(
      true,
    );
    expect(isGeneratedAssistantTextSignatureId("commentary-0")).toBe(false);
    expect(isGeneratedAssistantTextSignatureId("progress")).toBe(false);
    expect(isGeneratedAssistantTextSignatureId("msg_123")).toBe(false);
  });

  it("classifies ordinary and MiniMax generated commentary ids without treating provider ids as generated", () => {
    // Ordinary commentary stays a generated signature id but is not MiniMax-filtered (#135081).
    expect(isGeneratedAssistantTextSignatureId("commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(isGeneratedMiniMaxAssistantCommentaryId("commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      false,
    );
    expect(
      isGeneratedAssistantTextSignatureId("minimax-commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe(true);
    expect(
      isGeneratedMiniMaxAssistantCommentaryId("minimax-commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe(true);
    // final-answer / provider ids are never MiniMax commentary hides.
    expect(isGeneratedAssistantTextSignatureId("final-answer-1-bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(
      true,
    );
    expect(isGeneratedMiniMaxAssistantCommentaryId("final-answer-1-bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(
      false,
    );
    expect(isGeneratedAssistantTextSignatureId("msg_progress")).toBe(false);
    expect(isGeneratedMiniMaxAssistantCommentaryId("msg_progress")).toBe(false);
    expect(isGeneratedAssistantTextSignatureId("commentary-0")).toBe(false);
    expect(isGeneratedMiniMaxAssistantCommentaryId("commentary-0")).toBe(false);
  });
});

describe("shared/chat-message-content", () => {
  it.each(["commentary", "final_answer"] as const)(
    "lets explicit blocks override top-level %s without reviving unphased siblings",
    (phase) => {
      const opposite = phase === "commentary" ? "final_answer" : "commentary";
      const explicit = {
        type: "text",
        text: "Selected",
        textSignature: JSON.stringify({ v: 1, id: "selected", phase: opposite }),
      };
      const message = { phase, content: [{ type: "text", text: "Unphased sibling" }, explicit] };
      expect(readAssistantTextBlocksForPhase(message, phase)).toEqual([]);
      expect(readAssistantTextBlocksForPhase(message, opposite)).toEqual([explicit]);
      expect(extractAssistantTextForPhase(message, { phase })).toBeUndefined();
      expect(extractAssistantTextForPhase(message, { phase: opposite })).toBe("Selected");
    },
  );
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

describe("extractAssistantPhaseText", () => {
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
      extractAssistantPhaseText({
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
      extractAssistantPhaseText({
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
      extractAssistantPhaseText({
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
      extractAssistantPhaseText({
        role: "assistant",
        content: [{ type: "text", text: "Legacy answer" }],
      }),
    ).toBe("Legacy answer");
  });

  it("extracts persisted Responses output_text blocks as assistant-visible text", () => {
    expect(
      extractAssistantPhaseText({
        role: "assistant",
        content: [{ type: "output_text", text: "Persisted assistant answer" }],
      }),
    ).toBe("Persisted assistant answer");
  });

  it("extracts persisted Responses assistant input_text blocks", () => {
    expect(
      extractAssistantPhaseText({
        role: "assistant",
        content: [{ type: "input_text", text: "Persisted assistant input" }],
      }),
    ).toBe("Persisted assistant input");
  });

  it("does not mix unphased legacy text into final_answer output", () => {
    expect(
      extractAssistantPhaseText({
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

  it("reuses a block signature parse until the live block signature changes", () => {
    const block = {
      type: "text",
      text: "streaming text",
      textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
    };
    const parseSpy = vi.spyOn(JSON, "parse");

    expect(parseAssistantTextSignature(block)).toEqual({ id: "msg_1", phase: "commentary" });
    block.text += " delta";
    expect(parseAssistantTextSignature(block)).toEqual({ id: "msg_1", phase: "commentary" });
    expect(parseSpy).toHaveBeenCalledTimes(1);

    block.textSignature = JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" });
    expect(parseAssistantTextSignature(block)).toEqual({ id: "msg_2", phase: "final_answer" });
    expect(parseSpy).toHaveBeenCalledTimes(2);

    parseSpy.mockRestore();
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

it.each(["    code", "\tcode", "\n\n    code"])("retains selected phase source: %j", (text) => {
  expect(extractAssistantPhaseText({ role: "assistant", content: text })).toBe(text);
  expect(
    extractAssistantPhaseText({
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "text", text }],
    }),
  ).toBe(text);
});
