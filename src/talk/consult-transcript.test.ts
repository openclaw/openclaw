// Consult transcript tests cover transcript formatting for talk consults.
import { describe, expect, it } from "vitest";
import { classifySkippableRealtimeVoiceConsultTranscript } from "./consult-transcript.js";

describe("realtime voice consult transcript classification", () => {
  it("skips empty and incomplete transcripts", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("  ")).toBe("empty");
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you check...")).toBe(
      "incomplete-transcript",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you check…")).toBe(
      "incomplete-transcript",
    );
  });

  it("skips likely trailing fragments", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("tell me about")).toBe(
      "trailing-fragment",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("ship it so")).toBe("trailing-fragment");
  });

  it.each([
    "I'll be right back. See you guys. Bye-bye.",
    "Thanks and goodbye.",
    "All right, thanks and goodbye.",
    "Goodbye, take care",
    "Thank you very much and goodbye.",
    "Okay, goodbye and have a nice weekend.",
    "Bye for now, folks.",
    "See you next week.",
    "See you on Monday.",
    "I'll be right back in a minute.",
    "I will be back in a few minutes.",
    "I’ll be right back. Bye.",
    "Good bye.",
    "Good-bye.",
  ])("skips complete closing: %s", (text) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(text)).toBe("non-actionable-closing");
  });

  it.each([
    "Write a goodbye email to Sam",
    "I'll be right back, please check the build.",
    'Explain the code `print("goodbye")`.',
    "can you say goodbye?",
    "what changed in CI?",
    "Goodbye, everyone, please check the build.",
    "Thanks, goodbye. Send me the report.",
    'Translate "goodbye" into French.',
    "Thank you.",
  ])("keeps actionable transcript: %s", (text) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(text)).toBeUndefined();
  });
});
