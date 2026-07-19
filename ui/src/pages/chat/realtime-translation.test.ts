import { beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeTranslationSession } from "./realtime-translation.ts";

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();

class FakeTrack extends EventTarget {
  stop = vi.fn();
}

class FakeStream {
  readonly audio = new FakeTrack();
  readonly video = new FakeTrack();
  getAudioTracks() {
    return [this.audio] as unknown as MediaStreamTrack[];
  }
  getVideoTracks() {
    return [this.video] as unknown as MediaStreamTrack[];
  }
  getTracks() {
    return [this.audio, this.video] as unknown as MediaStreamTrack[];
  }
  removeTrack() {}
}

class FakeDataChannel extends EventTarget {
  readyState = "open";
  send = vi.fn();
  close = vi.fn();
}

class FakePeer extends EventTarget {
  connectionState = "connected";
  channel = new FakeDataChannel();
  addTrack = vi.fn();
  close = vi.fn();
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);
  createOffer = vi.fn(
    async () => ({ type: "offer", sdp: "offer-sdp" }) as RTCSessionDescriptionInit,
  );
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
}

describe("RealtimeTranslationSession", () => {
  let peer: FakePeer;

  beforeEach(() => {
    vi.restoreAllMocks();
    peer = new FakePeer();
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        constructor() {
          return peer;
        }
      },
    );
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia, getDisplayMedia },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp", { status: 200 })),
    );
    getUserMedia.mockReset().mockResolvedValue(new FakeStream());
    getDisplayMedia.mockReset().mockResolvedValue(new FakeStream());
  });

  it("creates a Chinese to English translation session", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
      offerUrl: "https://api.openai.com/v1/realtime/translations/calls",
    }));
    const session = new RealtimeTranslationSession({ request } as never, "zh-en", "microphone");

    await session.start();

    expect(request).toHaveBeenCalledWith("talk.translation.create", {
      sourceLanguage: "zh",
      targetLanguage: "en",
    });
    expect(getUserMedia).toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("uses shared tab audio for English to Chinese", async () => {
    const request = vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc",
      clientSecret: "secret",
      offerUrl: "https://api.openai.com/v1/realtime/translations/calls",
    }));
    const session = new RealtimeTranslationSession({ request } as never, "en-zh", "shared-audio");

    await session.start();

    expect(request).toHaveBeenCalledWith("talk.translation.create", {
      sourceLanguage: "en",
      targetLanguage: "zh",
    });
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
  });
});
