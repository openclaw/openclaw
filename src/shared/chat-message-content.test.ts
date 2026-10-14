// Chat message content tests cover visible text extraction from message parts.
import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantTextForPhase,
  extractAssistantPhaseText,
  extractFirstTextBlock,
  readAssistantTextBlocksForPhase,
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "./chat-message-content.js";

function phasedText(text: string, phase: "commentary" | "final_answer", id: string) {
  return { type: "text", text, textSignature: JSON.stringify({ v: 1, id, phase }) };
}

describe("shared/chat-message-content", () => {
  it.each(["final_answer"] as const)(
    "lets explicit blocks override top-level %s without reviving unphased siblings",
    (phase) => {
      const opposite = "commentary";
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

  it("returns plain string content", () => {
    expect(
      extractFirstTextBlock({
        content: "hello from string content",
      }),
    ).toBe("hello from string content");
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
            phasedText("Hi ", "final_answer", "msg_final_1"),
            phasedText("there", "final_answer", "msg_final_2"),
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
          phasedText("thinking like caveman", "commentary", "msg_commentary"),
          phasedText("Actual final answer", "final_answer", "msg_final"),
        ],
      }),
    ).toBe("Actual final answer");
  });

  it("does not fall back to commentary-only text", () => {
    expect(
      extractAssistantPhaseText({
        role: "assistant",
        content: [phasedText("thinking like caveman", "commentary", "msg_commentary")],
      }),
    ).toBeUndefined();
  });

  it("does not fall back to unphased legacy text when final_answer is empty", () => {
    expect(
      extractAssistantPhaseText({
        role: "assistant",
        content: [
          { type: "text", text: "Legacy answer" },
          phasedText("   ", "final_answer", "msg_final"),
        ],
      }),
    ).toBeUndefined();
  });

  it("extracts persisted Responses output_text blocks as assistant-visible text", () => {
    expect(
      extractAssistantPhaseText({
        role: "assistant",
        content: [{ type: "output_text", text: "Persisted assistant answer" }],
      }),
    ).toBe("Persisted assistant answer");
  });
});

describe("resolveAssistantMessagePhase", () => {
  it("prefers the top-level assistant phase when present", () => {
    expect(resolveAssistantMessagePhase({ role: "assistant", phase: "commentary" })).toBe(
      "commentary",
    );
  });

  it("reuses a block signature parse until the live block signature changes", () => {
    const block = phasedText("streaming text", "commentary", "msg_1");
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
        content: [phasedText("Actual final answer", "final_answer", "msg_final")],
      }),
    ).toBe("final_answer");
  });

  it("returns undefined when text blocks contain mixed explicit phases", () => {
    expect(
      resolveAssistantMessagePhase({
        role: "assistant",
        content: [
          phasedText("Working...", "commentary", "msg_commentary"),
          phasedText("Done.", "final_answer", "msg_final"),
        ],
      }),
    ).toBeUndefined();
  });
});

it.each(["\n\n    code"])("retains selected phase source: %j", (text) => {
  expect(extractAssistantPhaseText({ role: "assistant", content: text })).toBe(text);
  expect(
    extractAssistantPhaseText({
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "text", text }],
    }),
  ).toBe(text);
});
