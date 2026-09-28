import { describe, expect, it } from "vitest";
import {
  shouldAcceptMicStart,
  shouldClearCreateErrorOnClose,
  voiceLabSubmitBlock,
} from "./tts-voice-lab-state.ts";

describe("TTS voice lab eligibility", () => {
  it.each([
    [{ name: "", consentMs: 4000, sourceMs: 12000 }, "needName"],
    [{ name: "Test", consentMs: 500, sourceMs: 12000 }, "needConsent"],
    [{ name: "Test", consentMs: 4000, sourceMs: 8000 }, "needSource"],
    [{ name: "Test", consentMs: 4000, sourceMs: 31000 }, "sourceTooLong"],
    [{ name: "Test", consentMs: 4000, sourceMs: 12000 }, null],
  ] as const)("validates recordings and name", (input, expected) => {
    expect(voiceLabSubmitBlock({ ...input, connected: true })).toBe(expected);
  });
  it("keeps in-flight errors on close and drops late microphone starts", () => {
    expect(shouldClearCreateErrorOnClose(true)).toBe(false);
    expect(shouldClearCreateErrorOnClose(false)).toBe(true);
    expect(shouldAcceptMicStart({ session: 1, currentSession: 2, dialogOpen: false })).toBe(false);
    expect(shouldAcceptMicStart({ session: 1, currentSession: 1, dialogOpen: true })).toBe(true);
  });
});
