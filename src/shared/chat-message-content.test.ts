import { expect, it, vi } from "vitest";
import {
  extractAssistantTextForPhase as extract,
  extractAssistantPhaseText as phaseText,
  extractFirstTextBlock as firstText,
  parseAssistantTextSignature as signature,
  resolveAssistantMessagePhase as messagePhase,
} from "./chat-message-content.js";

function phasedText(text: string, phase: "commentary" | "final_answer", id: string) {
  return { type: "text", text, textSignature: JSON.stringify({ v: 1, id, phase }) };
}
const assistant = (content: unknown) => ({ role: "assistant", content });
const commentary = phasedText("thinking like caveman", "commentary", "msg_commentary");
const finalAnswer = phasedText("Actual final answer", "final_answer", "msg_final");
function expectPhaseText(content: unknown, expected: string | undefined) {
  expect(phaseText(assistant(content))).toBe(expected);
}

it("lets explicit blocks override top-level final_answer without reviving unphased siblings", () => {
  const phase = "final_answer";
  const opposite = "commentary";
  const explicit = phasedText("Selected", opposite, "selected");
  const message = { phase, content: [{ type: "text", text: "Unphased sibling" }, explicit] };
  expect(extract(message, { phase })).toBeUndefined();
  expect(extract(message, { phase: opposite })).toBe("Selected");
});

it("returns plain string content", () => {
  expect(firstText({ content: "hello" })).toBe("hello");
});

it("returns undefined for missing, empty, or non-text content", () => {
  expect(firstText(null)).toBeUndefined();
  expect(firstText({ content: [] })).toBeUndefined();
  expect(firstText({ content: [{ type: "image" }] })).toBeUndefined();
  expect(firstText({ content: ["hello"] })).toBeUndefined();
  expect(firstText({ content: [{ text: 1 }, { text: "later" }] })).toBeUndefined();
});
it("preserves boundary spacing when newline-joining adjacent final_answer text blocks", () => {
  const content = ["Hi ", "there"].map((text, i) => phasedText(text, "final_answer", `msg_${i}`));
  expect(extract(assistant(content), { phase: "final_answer" })).toBe("Hi \nthere");
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
it.each([
  [{ role: "assistant", phase: "commentary" }, "commentary"],
  [assistant([finalAnswer]), "final_answer"],
  [assistant([commentary, finalAnswer]), undefined],
])("resolves top-level or unanimous block phase: %j", (message, expected) => {
  expect(messagePhase(message)).toBe(expected);
});

it("reuses a block signature parse until the live block signature changes", () => {
  const block = phasedText("streaming text", "commentary", "msg_1");
  const parseSpy = vi.spyOn(JSON, "parse");

  expect(signature(block)).toEqual({ id: "msg_1", phase: "commentary" });
  block.text += " delta";
  expect(signature(block)).toEqual({ id: "msg_1", phase: "commentary" });
  expect(parseSpy).toHaveBeenCalledTimes(1);

  block.textSignature = JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" });
  expect(signature(block)).toEqual({ id: "msg_2", phase: "final_answer" });
  expect(parseSpy).toHaveBeenCalledTimes(2);

  parseSpy.mockRestore();
});

it("retains selected phase source", () => {
  const text = "\n\n    code";
  expectPhaseText(text, text);
  expect(phaseText({ ...assistant([{ type: "text", text }]), phase: "final_answer" })).toBe(text);
});
