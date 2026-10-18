import { describe, expect, it } from "vitest";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { extractStoredAssistantText } from "./chat-history-text.js";

describe("extractStoredAssistantText", () => {
  it.each([
    [
      "tool calls",
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> [Tool Call: foo (ID: 1)] world',
      "Hello  world",
      ["invoke", "Tool Call"],
    ],
    [
      "tool results",
      'Prefix\n<tool_result>{"output":"hidden"}</tool_result>\nSuffix',
      "Prefix\n\nSuffix",
      ["tool_result"],
    ],
    ["thinking", "Before <think>secret</think> after", "Before  after", []],
    [
      "adjacent blocks",
      [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
      "Hi there",
      [],
    ],
  ] as const)("sanitizes %s without adding separators", (_name, content, expected, hidden) => {
    const text = extractStoredAssistantText({ role: "assistant", content });
    const result = typeof content === "string" ? text?.trim() : text;
    expect(result).toBe(expected);
    for (const marker of hidden) {
      expect(result).not.toContain(marker);
    }
  });

  it.each([
    {
      name: "transcript error",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "500 Internal Server Error",
        content: [{ type: "text", text: "500 Internal Server Error" }],
      },
      expected: "HTTP 500: Internal Server Error",
    },
    {
      name: "normal billing status",
      message: textAssistant(
        "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
      ),
      expected:
        "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    },
    {
      name: "successful turn with stale errorMessage",
      message: {
        role: "assistant",
        stopReason: "end_turn",
        errorMessage: "insufficient credits for embedding model",
        content: [{ type: "text", text: "Handle payment required errors in your API." }],
      },
      expected: "Handle payment required errors in your API.",
    },
  ])("rewrites only transcript errors: $name", ({ message, expected }) => {
    expect(extractStoredAssistantText(message)).toBe(expected);
  });

  it("prefers final_answer text when phased assistant history is present", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    };
    expect(extractStoredAssistantText(message)).toBe("Done.");
  });
});
