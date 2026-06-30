import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DictationRecorder,
  insertDictation,
  type DictationSnapshot,
} from "./dictation-recorder.ts";

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.dispatchEvent(new MessageEvent("dataavailable", { data: new Blob(["voice"]) }));
    this.dispatchEvent(new Event("stop"));
  }
}

describe("DictationRecorder", () => {
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));

  beforeEach(() => {
    vi.useFakeTimers();
    stop.mockReset();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", undefined);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });

  it("records an in-memory clip and releases the microphone on confirm", async () => {
    const states: DictationSnapshot[] = [];
    const recorder = new DictationRecorder({ onChange: (state) => states.push(state) });

    await recorder.start();
    expect(recorder.state.phase).toBe("recording");
    const blob = await recorder.confirm();

    expect(blob?.size).toBeGreaterThan(0);
    expect(recorder.state.phase).toBe("transcribing");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("maps permission denial to recovery guidance", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const recorder = new DictationRecorder({ onChange: vi.fn() });

    await recorder.start();

    expect(recorder.state).toMatchObject({
      phase: "error",
      error: expect.stringContaining("Allow microphone access"),
    });
  });

  it("honors shortcut release while permission is still pending", async () => {
    let grantPermission!: (stream: { getTracks: () => Array<{ stop: typeof stop }> }) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          grantPermission = resolve;
        }),
    );
    const recorder = new DictationRecorder({ onChange: vi.fn() });

    const started = recorder.start();
    const confirmed = recorder.confirm();
    grantPermission({ getTracks: () => [{ stop }] });

    await started;
    await expect(confirmed).resolves.toBeInstanceOf(Blob);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("cancels without producing a clip", async () => {
    const recorder = new DictationRecorder({ onChange: vi.fn() });
    await recorder.start();

    recorder.cancel();

    expect(recorder.state.phase).toBe("idle");
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("insertDictation", () => {
  it("inserts at the captured selection with natural spacing", () => {
    expect(insertDictation("Ask  please", "OpenClaw to summarize this", 4, 5)).toBe(
      "Ask OpenClaw to summarize this please",
    );
  });
});
