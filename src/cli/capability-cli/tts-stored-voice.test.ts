import { describe, expect, it } from "vitest";
import { storedVoicePreviewOutputs } from "./tts-stored-voice.js";

describe("stored voice CLI preview outputs", () => {
  it("reports a replicated voice id without writing an empty preview", () => {
    expect(
      storedVoicePreviewOutputs({
        target: "/tmp/preview.wav",
        audio: Buffer.alloc(0),
        mimeType: "audio/wav",
      }),
    ).toEqual([]);
    expect(
      storedVoicePreviewOutputs({
        target: "",
        audio: Buffer.from("wav"),
        mimeType: "audio/wav",
      }),
    ).toEqual([]);
    expect(
      storedVoicePreviewOutputs({
        target: "/tmp/preview.wav",
        audio: Buffer.from("wav"),
        mimeType: "audio/wav",
      }),
    ).toEqual([{ path: "/tmp/preview.wav", format: "audio/wav" }]);
  });
});
