import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeTalkSelectedMicrophoneError } from "../chat/talk/input.ts";
import { TtsClipRecorder, TtsClipRecorderCancelledError } from "./tts-clip-recorder.ts";

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

  it("does not publish a context resumed after dispose", async () => {
    let resume!: () => void;
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        sampleRate = 24_000;
        resume() {
          return new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
        close() {
          return close();
        }
      },
    );
    const { RealtimeTalkInputController } = await import("../chat/talk/input.ts");
    const stopTrack = vi.fn();
    vi.spyOn(RealtimeTalkInputController.prototype, "open").mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    const recorder = new TtsClipRecorder();
    const started = recorder.start({ deviceId: "mic-1" });
    await vi.waitFor(() => {
      expect(typeof resume).toBe("function");
    });
    recorder.dispose();
    resume();
    await expect(started).rejects.toBeInstanceOf(TtsClipRecorderCancelledError);
    expect(recorder.recording).toBe(false);
    expect(stopTrack).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("stops the opened microphone when AudioContext fails to start", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("audio context failed");
        }
      },
    );
    const { RealtimeTalkInputController } = await import("../chat/talk/input.ts");
    const stopTrack = vi.fn();
    const stop = vi.spyOn(RealtimeTalkInputController.prototype, "stop");
    vi.spyOn(RealtimeTalkInputController.prototype, "open").mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    const recorder = new TtsClipRecorder();
    await expect(recorder.start({ deviceId: "mic-1" })).rejects.toThrow(/audio context failed/);
    expect(stopTrack).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(recorder.recording).toBe(false);
  });
});
