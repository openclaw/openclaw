import { describe, expect, it } from "vitest";
import { isStoredSpeechVoice, voiceLabCanSubmit } from "./tts-voice-lab-state.ts";

describe("TTS voice lab", () => {
  it("keeps only stored custom voices from the project catalog", () => {
    expect(isStoredSpeechVoice({ id: "voice_abc", category: "prompted" })).toBe(true);
    expect(isStoredSpeechVoice({ id: "voice_xyz", category: "replicated" })).toBe(true);
    expect(isStoredSpeechVoice({ id: "Kore", category: "prebuilt" })).toBe(false);
    expect(isStoredSpeechVoice({ id: "en-us-tutor-1", category: "prebuilt" })).toBe(false);
  });

  it("requires a name, a consent take, and a 10-30s reference take", () => {
    expect(voiceLabCanSubmit({ name: "Bobby", consentMs: 4_000, sourceMs: 12_000 })).toBe(true);
    expect(voiceLabCanSubmit({ name: "  ", consentMs: 4_000, sourceMs: 12_000 })).toBe(false);
    expect(voiceLabCanSubmit({ name: "Bobby", consentMs: 500, sourceMs: 12_000 })).toBe(false);
    expect(voiceLabCanSubmit({ name: "Bobby", consentMs: 4_000, sourceMs: 8_000 })).toBe(false);
    expect(voiceLabCanSubmit({ name: "Bobby", consentMs: 4_000, sourceMs: 31_000 })).toBe(false);
  });
});
