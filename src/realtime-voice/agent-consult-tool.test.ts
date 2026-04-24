import { describe, expect, it } from "vitest";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  parseRealtimeVoiceAgentConsultArgs,
} from "./agent-consult-tool.js";

describe("realtime voice agent consult tool", () => {
  it("normalizes shared tool arguments for browser chat forwarding", () => {
    expect(
      buildRealtimeVoiceAgentConsultChatMessage({
        question: "  What changed? ",
        context: "  PR #123 ",
        responseStyle: " concise ",
      }),
    ).toBe("What changed?\n\nContext:\nPR #123\n\nSpoken style:\nconcise");
  });

  it("requires a non-empty question", () => {
    expect(() => parseRealtimeVoiceAgentConsultArgs({ context: "missing" })).toThrow(
      "question required",
    );
  });

  it("builds a reusable spoken consultant prompt with recent transcript", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "Do we support realtime tools?" },
      transcript: [
        { role: "user", text: "Can you check the repo?" },
        { role: "assistant", text: "I'll verify." },
      ],
      surface: "a private Google Meet",
      userLabel: "Participant",
      assistantLabel: "Agent",
      questionSourceLabel: "participant",
    });

    expect(prompt).toContain("during a private Google Meet");
    expect(prompt).toContain("Participant: Can you check the repo?");
    expect(prompt).toContain("Agent: I'll verify.");
    expect(prompt).toContain("Question:\nDo we support realtime tools?");
  });

  it("filters reasoning and error payloads from visible consult output", () => {
    expect(
      collectRealtimeVoiceAgentConsultVisibleText([
        { text: "thinking", isReasoning: true },
        { text: "first" },
        { text: "error", isError: true },
        { text: "second" },
      ]),
    ).toBe("first\n\nsecond");
  });
});
