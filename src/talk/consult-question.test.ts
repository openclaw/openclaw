// Consult question tests cover question extraction for agent consultation.
import { describe, expect, it } from "vitest";
import {
  matchRealtimeVoiceConsultQuestions,
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
} from "./consult-question.js";

describe("realtime voice consult question helpers", () => {
  it("reads common provider question fields", () => {
    expect(readRealtimeVoiceConsultQuestion({ question: " check status " })).toBe("check status");
    expect(readRealtimeVoiceConsultQuestion({ prompt: "look up docs" })).toBe("look up docs");
    expect(readRealtimeVoiceConsultQuestion({ query: "find logs" })).toBe("find logs");
    expect(readRealtimeVoiceConsultQuestion({ task: "summarize" })).toBe("summarize");
    expect(readRealtimeVoiceConsultQuestion({ question: "   " })).toBeUndefined();
  });

  it("matches exact, contained, and token-overlap questions conservatively", () => {
    expect(matchRealtimeVoiceConsultQuestions("Can you check this?", "check this")).toBe(true);
    expect(
      matchRealtimeVoiceConsultQuestions(
        "Send me a Discord message after checking the branch",
        "check branch and send Discord message",
      ),
    ).toBe(true);
    expect(matchRealtimeVoiceConsultQuestions("check this branch", "restart the server")).toBe(
      false,
    );
    expect(matchRealtimeVoiceConsultQuestions("restart server", "check server")).toBe(false);
  });

  it("extracts bounded speakable text from tool results", () => {
    expect(readSpeakableRealtimeVoiceToolResult({ response: " Brain response " })).toBe(
      "Brain response",
    );
    expect(readSpeakableRealtimeVoiceToolResult({ spokenText: "Spoken" })).toBe("Spoken");
    expect(readSpeakableRealtimeVoiceToolResult({ summaryText: "Summary" })).toBe("Summary");
    expect(readSpeakableRealtimeVoiceToolResult({ text: " Answer " })).toBe("Answer");
    expect(readSpeakableRealtimeVoiceToolResult({ result: "Result" })).toBe("Result");
    expect(readSpeakableRealtimeVoiceToolResult("Direct")).toBe("Direct");
    expect(
      readSpeakableRealtimeVoiceToolResult(
        { text: "abcdefghijklmnopqrstuvwxyz" },
        { maxChars: 24 },
      ),
    ).toBe("abcdefgh [truncated]");
  });

  it("prefers structured voice fields over raw JSON strings", () => {
    expect(
      readSpeakableRealtimeVoiceToolResult('{"response":"Read this","debug":"not this"}'),
    ).toBe("Read this");
    expect(
      readSpeakableRealtimeVoiceToolResult(
        '{"spokenText":"Speak only this","response":"fallback"}\nextra diagnostic text',
      ),
    ).toBe("fallback");
    expect(
      readSpeakableRealtimeVoiceToolResult('{"debug":"no voice field"}', { stringResult: false }),
    ).toBeUndefined();
  });
});
