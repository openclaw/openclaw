// Assistant phase text tests cover extracting final-answer text from signed
// assistant message phases.
import { describe, expect, it } from "vitest";
import { extractAssistantText as extractChatHistoryAssistantText } from "./chat-history-text.js";
<<<<<<< HEAD
=======
import { extractAssistantText as extractSessionAssistantText } from "./session-message-text.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

function assistantTextPart(id: string, phase: string, text: string) {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, id, phase }),
  };
}

function assistantMessage(...content: ReturnType<typeof assistantTextPart>[]) {
  return {
    role: "assistant",
    content,
  };
}

<<<<<<< HEAD
=======
const assistantTextExtractors = [
  ["chat history", extractChatHistoryAssistantText],
  ["session message", extractSessionAssistantText],
] as const;

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
describe("phase-aware assistant text helpers", () => {
  it("fails soft for malformed inputs", () => {
    for (const message of [null, 42, "broken history entry"]) {
      expect(extractChatHistoryAssistantText(message)).toBeUndefined();
<<<<<<< HEAD
    }
  });

  it("prefers final_answer text over commentary", () => {
    const message = assistantMessage(
      assistantTextPart("commentary", "commentary", "Need verify healthy."),
      assistantTextPart("final", "final_answer", "Health check completed successfully."),
    );

    expect(extractChatHistoryAssistantText(message)).toBe("Health check completed successfully.");
  });

  it("preserves spaces across split final_answer blocks", () => {
    const message = assistantMessage(
      assistantTextPart("commentary", "commentary", "Need verify healthy."),
      assistantTextPart("final_1", "final_answer", "Hi "),
      assistantTextPart("final_2", "final_answer", "<think>secret</think>there"),
    );

    expect(extractChatHistoryAssistantText(message)).toBe("Hi there");
  });
=======
      expect(extractSessionAssistantText(message)).toBeUndefined();
    }
  });

  for (const [label, extractAssistantText] of assistantTextExtractors) {
    it(`prefers final_answer text over commentary in ${label} helpers`, () => {
      const message = assistantMessage(
        assistantTextPart("commentary", "commentary", "Need verify healthy."),
        assistantTextPart("final", "final_answer", "Health check completed successfully."),
      );

      expect(extractAssistantText(message)).toBe("Health check completed successfully.");
    });

    it(`preserves spaces across split final_answer blocks in ${label} helpers`, () => {
      const message = assistantMessage(
        assistantTextPart("commentary", "commentary", "Need verify healthy."),
        assistantTextPart("final_1", "final_answer", "Hi "),
        assistantTextPart("final_2", "final_answer", "<think>secret</think>there"),
      );

      expect(extractAssistantText(message)).toBe("Hi there");
    });
  }
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

  it("does not fall back to commentary when an explicit final_answer is empty", () => {
    // An explicit empty final answer means there is no publishable response;
    // commentary should stay private.
    const message = assistantMessage(
      assistantTextPart("commentary", "commentary", "Need simpler use cat overwrite full file."),
      assistantTextPart("final", "final_answer", "   "),
    );

    expect(extractChatHistoryAssistantText(message)).toBeUndefined();
  });
});
