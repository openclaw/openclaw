import { describe, expect, it } from "vitest";
import {
  isGoogleVoiceStoreBusy,
  isGoogleVoiceStoreInternal,
  isGoogleVoiceStoreUncertain,
  isStoredSpeechVoice,
  storedVoiceMatchingName,
  shouldAcceptMicStart,
  shouldClearCreateErrorOnClose,
  voiceLabCanSubmit,
  voiceLabSubmitBlock,
} from "./tts-voice-lab-state.ts";

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
    expect(
      voiceLabSubmitBlock({
        name: "",
        consentMs: 10_900,
        sourceMs: 29_500,
        connected: true,
      }),
    ).toBe("needName");
    expect(
      voiceLabSubmitBlock({
        name: "Bobby",
        consentMs: 10_900,
        sourceMs: 29_500,
        connected: false,
      }),
    ).toBe("disconnected");
  });

  it("keeps an in-flight store guarded after the dialog closes", () => {
    expect(shouldClearCreateErrorOnClose(true)).toBe(false);
    expect(shouldClearCreateErrorOnClose(false)).toBe(true);
  });

  it("drops a pending microphone start after the dialog closes", () => {
    expect(shouldAcceptMicStart({ session: 1, currentSession: 1, dialogOpen: true })).toBe(true);
    expect(shouldAcceptMicStart({ session: 1, currentSession: 2, dialogOpen: false })).toBe(false);
    expect(shouldAcceptMicStart({ session: 1, currentSession: 1, dialogOpen: false })).toBe(false);
  });

  it("treats Google 503 UNAVAILABLE as a busy voice store", () => {
    expect(
      isGoogleVoiceStoreBusy(
        new Error(
          "ProviderHttpError: Google voices request failed (503): The service is currently unavailable. [code=UNAVAILABLE]",
        ),
      ),
    ).toBe(true);
    expect(isGoogleVoiceStoreBusy(new Error("invalid consent audio"))).toBe(false);
    expect(
      isGoogleVoiceStoreInternal(
        new Error(
          "ProviderHttpError: Google voices request failed (500): Internal error encountered. [code=INTERNAL]",
        ),
      ),
    ).toBe(true);
  });

  it("locks Store after an uncertain 503 until the list is reconciled", () => {
    const busy = new Error(
      "ProviderHttpError: Google voices request failed (503): The service is currently unavailable. [code=UNAVAILABLE]",
    );
    expect(isGoogleVoiceStoreUncertain(busy)).toBe(true);
    expect(isGoogleVoiceStoreUncertain(new Error("request timeout"))).toBe(true);
    expect(isGoogleVoiceStoreUncertain(new Error("invalid consent audio"))).toBe(false);
    expect(
      voiceLabSubmitBlock({
        name: "Bobby",
        consentMs: 10_900,
        sourceMs: 12_000,
        connected: true,
        storeUncertain: true,
      }),
    ).toBe("storeUncertain");
    expect(
      storedVoiceMatchingName(
        [
          { id: "Kore", category: "prebuilt" },
          { id: "voice_abc", name: "Bobby", category: "replicated" },
        ],
        "Bobby",
      )?.id,
    ).toBe("voice_abc");
  });
});
