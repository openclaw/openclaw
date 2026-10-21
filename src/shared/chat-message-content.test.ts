import { expect, it, vi } from "vitest";
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
const assistant = (content: unknown) => ({ role: "assistant", content });
const commentary = phasedText("thinking like caveman", "commentary", "msg_commentary");
const finalAnswer = phasedText("Actual final answer", "final_answer", "msg_final");
function expectPhaseText(content: unknown, expected: string | undefined) {
  expect(extractAssistantPhaseText(assistant(content))).toBe(expected);
}
function expectMessagePhase(content: unknown[], expected: string | undefined) {
  expect(resolveAssistantMessagePhase(assistant(content))).toBe(expected);
}

it("lets explicit blocks override top-level final_answer without reviving unphased siblings", () => {
  const phase = "final_answer";
  const opposite = "commentary";
  const explicit = phasedText("Selected", opposite, "selected");
  const message = { phase, content: [{ type: "text", text: "Unphased sibling" }, explicit] };
  expect(readAssistantTextBlocksForPhase(message, phase)).toEqual([]);
  expect(readAssistantTextBlocksForPhase(message, opposite)).toEqual([explicit]);
  expect(extractAssistantTextForPhase(message, { phase })).toBeUndefined();
  expect(extractAssistantTextForPhase(message, { phase: opposite })).toBe("Selected");
});

it("returns plain string content", () => {
  expect(extractFirstTextBlock({ content: "hello from string content" })).toBe(
    "hello from string content",
  );
});

it("returns undefined for missing, empty, or non-text content", () => {
  expect(extractFirstTextBlock(null)).toBeUndefined();
  expect(extractFirstTextBlock({ content: [] })).toBeUndefined();
  expect(extractFirstTextBlock({ content: [{ type: "image" }] })).toBeUndefined();
  expect(extractFirstTextBlock({ content: ["hello"] })).toBeUndefined();
  expect(extractFirstTextBlock({ content: [{ text: 1 }, { text: "later" }] })).toBeUndefined();
});
it("preserves boundary spacing when joining adjacent final_answer text blocks", () => {
  expect(
    extractAssistantTextForPhase(
      assistant([
        phasedText("Hi ", "final_answer", "msg_final_1"),
        phasedText("there", "final_answer", "msg_final_2"),
      ]),
      { phase: "final_answer", joinWith: "" },
    ),
  ).toBe("Hi there");
});

it.each<[string, unknown, string | undefined]>([
  ["prefers final over commentary", [commentary, finalAnswer], "Actual final answer"],
  ["rejects commentary-only text", [commentary], undefined],
  [
    "rejects legacy text with an empty final answer",
    [{ type: "text", text: "Legacy answer" }, phasedText("   ", "final_answer", "msg_final")],
    undefined,
  ],
  [
    "extracts persisted output_text",
    [{ type: "output_text", text: "Persisted answer" }],
    "Persisted answer",
  ],
])("%s", (_name, content, expected) => {
  expectPhaseText(content, expected);
});
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
  expectMessagePhase([finalAnswer], "final_answer");
});

it("returns undefined when text blocks contain mixed explicit phases", () => {
  expectMessagePhase(
    [
      phasedText("Working...", "commentary", "msg_commentary"),
      phasedText("Done.", "final_answer", "msg_final"),
    ],
    undefined,
  );
});
it("retains selected phase source", () => {
  const text = "\n\n    code";
  expectPhaseText(text, text);
  expect(
    extractAssistantPhaseText({
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "text", text }],
    }),
  ).toBe(text);
});
