import { describe, expect, it } from "vitest";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { extractStoredAssistantText } from "./chat-history-text.js";

describe("extractStoredAssistantText sanitization", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    // Session recall should not replay provider/tool markup as assistant text.
    const input =
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> ' +
      "[Tool Call: foo (ID: 1)] world";
    const result = extractStoredAssistantText({ role: "assistant", content: input })?.trim();
    expect(result).toBe("Hello  world");
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("Tool Call");
  });

  it("strips tool_result XML via the shared assistant-visible sanitizer", () => {
    const input = 'Prefix\n<tool_result>{"output":"hidden"}</tool_result>\nSuffix';
    const result = extractStoredAssistantText({ role: "assistant", content: input })?.trim();
    expect(result).toBe("Prefix\n\nSuffix");
    expect(result).not.toContain("tool_result");
  });

  it("strips thinking tags", () => {
    const input = "Before <think>secret</think> after";
    const result = extractStoredAssistantText({ role: "assistant", content: input })?.trim();
    expect(result).toBe("Before  after");
  });
});

describe("extractStoredAssistantText", () => {
  it("sanitizes blocks without injecting newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
    };
    expect(extractStoredAssistantText(message)).toBe("Hi there");
  });

  it("rewrites error-ish assistant text only when the transcript marks it as an error", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    };
    expect(extractStoredAssistantText(message)).toBe("HTTP 500: Internal Server Error");
  });

  it("keeps normal status text that mentions billing", () => {
    const message = textAssistant(
      "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    );
    expect(extractStoredAssistantText(message)).toBe(
      "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    );
  });

  it("preserves successful turns with stale background errorMessage", () => {
    const message = {
      role: "assistant",
      stopReason: "end_turn",
      errorMessage: "insufficient credits for embedding model",
      content: [{ type: "text", text: "Handle payment required errors in your API." }],
    };
    expect(extractStoredAssistantText(message)).toBe("Handle payment required errors in your API.");
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
