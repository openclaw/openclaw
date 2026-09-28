import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTalkSelectedMicrophoneError } from "../chat/talk/input.ts";
import { TtsClipRecorder } from "./tts-clip-recorder.ts";

describe("TTS clip recorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not open the default microphone after an exact selection fails", async () => {
    const { RealtimeTalkInputController } = await import("../chat/talk/input.ts");
    const open = vi
      .spyOn(RealtimeTalkInputController.prototype, "open")
      .mockRejectedValue(new RealtimeTalkSelectedMicrophoneError());
    const recorder = new TtsClipRecorder();
    await expect(recorder.start({ deviceId: "mic-1" })).rejects.toBeInstanceOf(
      RealtimeTalkSelectedMicrophoneError,
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("mic-1");
  });
});
