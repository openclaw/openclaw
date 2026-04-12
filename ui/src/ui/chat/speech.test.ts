import { afterEach, describe, expect, it, vi } from "vitest";
import { startStt, stopStt } from "./speech.ts";

type FakeTrack = { stop: ReturnType<typeof vi.fn> };

class FakeRecognition extends EventTarget {
  continuous = false;
  interimResults = false;
  lang = "en-US";
  onresult = null;
  onerror = null;
  onend = null;
  onstart = null;

  start() {
    this.dispatchEvent(new Event("start"));
  }

  stop() {
    this.dispatchEvent(new Event("end"));
  }

  abort() {
    this.dispatchEvent(new Event("end"));
  }
}

class ThrowingRecognition extends FakeRecognition {
  override start() {
    throw new DOMException("Permission denied", "NotAllowedError");
  }
}

function stubMediaDevicesGetUserMedia(impl: () => Promise<{ getTracks: () => FakeTrack[] }>) {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(impl) },
  });
}

describe("speech STT", () => {
  afterEach(() => {
    stopStt();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
  });

  it("reports unsupported browsers", async () => {
    const onError = vi.fn();

    await expect(
      startStt({
        onTranscript: () => undefined,
        onError,
      }),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledWith("Speech recognition is not supported in this browser");
  });

  it("reports blocked microphone permissions before starting recognition", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    stubMediaDevicesGetUserMedia(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const onError = vi.fn();

    await expect(
      startStt({
        onTranscript: () => undefined,
        onError,
      }),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledWith("NotAllowedError");
  });

  it("stops the temporary microphone stream and starts recognition", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const stop = vi.fn();
    stubMediaDevicesGetUserMedia(async () => ({
      getTracks: () => [{ stop }],
    }));
    const onStart = vi.fn();

    await expect(
      startStt({
        onTranscript: () => undefined,
        onStart,
      }),
    ).resolves.toBe(true);

    expect(stop).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("reports recognition startup errors", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("webkitSpeechRecognition", ThrowingRecognition);
    stubMediaDevicesGetUserMedia(async () => ({
      getTracks: () => [],
    }));
    const onError = vi.fn();

    await expect(
      startStt({
        onTranscript: () => undefined,
        onError,
      }),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledWith("NotAllowedError");
  });
});
