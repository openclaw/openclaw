import { describe, expect, it } from "vitest";
import { extractAssistantText as extractChatHistoryAssistantText } from "./chat-history-text.js";
import { extractAssistantText as extractSessionAssistantText } from "./session-message-text.js";

describe("phase-aware assistant text helpers", () => {
  it("fails soft for malformed inputs", () => {
    for (const message of [null, 42, "broken history entry"]) {
      expect(extractChatHistoryAssistantText(message)).toBeUndefined();
      expect(extractSessionAssistantText(message)).toBeUndefined();
    }
  });

  it("prefers final_answer text over commentary in chat history helpers", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need fix line quoting properly.",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Fixed the quoting issue.",
          textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
        },
      ],
    };

    expect(extractChatHistoryAssistantText(message)).toBe("Fixed the quoting issue.");
  });

  it("does not fall back to commentary when an explicit final_answer is empty", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need simpler use cat overwrite full file.",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "   ",
          textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
        },
      ],
    };

    expect(extractChatHistoryAssistantText(message)).toBeUndefined();
  });

  it("preserves spaces across split final_answer blocks in chat history helpers", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need verify healthy.",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Hi ",
          textSignature: JSON.stringify({ v: 1, id: "final_1", phase: "final_answer" }),
        },
        {
          type: "text",
          text: "<think>secret</think>there",
          textSignature: JSON.stringify({ v: 1, id: "final_2", phase: "final_answer" }),
        },
      ],
    };

    expect(extractChatHistoryAssistantText(message)).toBe("Hi there");
  });

  it("prefers final_answer text over commentary in session message helpers", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need verify healthy.",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Health check completed successfully.",
          textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
        },
      ],
    };

    expect(extractSessionAssistantText(message)).toBe("Health check completed successfully.");
  });

  it("preserves spaces across split final_answer blocks in session message helpers", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need verify healthy.",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Hi ",
          textSignature: JSON.stringify({ v: 1, id: "final_1", phase: "final_answer" }),
        },
        {
          type: "text",
          text: "<think>secret</think>there",
          textSignature: JSON.stringify({ v: 1, id: "final_2", phase: "final_answer" }),
        },
      ],
    };

    expect(extractSessionAssistantText(message)).toBe("Hi there");
  });
});
