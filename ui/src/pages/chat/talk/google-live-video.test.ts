// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import type { RealtimeTalkCallbacks } from "./shared.ts";

class FakeGoogleLiveWebSocket extends EventTarget {
  static OPEN = 1;
  static instance: FakeGoogleLiveWebSocket | undefined;

  readyState = FakeGoogleLiveWebSocket.OPEN;
  readonly sent: unknown[] = [];
  binaryType: BinaryType = "blob";

  constructor(readonly url: string) {
    super();
    FakeGoogleLiveWebSocket.instance = this;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

class FakeAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24_000;
  }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null };
  }

  createGain() {
    return { connect() {}, disconnect() {}, gain: { value: 1 } };
  }

  async close(): Promise<void> {}
}

function audioFixture() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

function cameraFixture(deviceId?: string) {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    readyState: "live",
    enabled: true,
    muted: false,
    ...(deviceId ? { getSettings: () => ({ deviceId }) } : {}),
  });
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

async function createTransport(callbacks: RealtimeTalkCallbacks, videoDeviceId?: string) {
  return new GoogleLiveRealtimeTalkTransport(
    {
      provider: "google",
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      // Fake harness token, assembled so secret scanners do not flag it.
      clientSecret: ["auth_tokens", "browser-video-test"].join("/"),
      websocketUrl:
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 16_000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24_000,
      },
    },
    {
      input: await prepareRealtimeTalkTestInput(),
      callbacks,
      client: { request: vi.fn(), addEventListener: vi.fn() } as never,
      sessionKey: "main",
      videoDeviceId,
    },
  );
}

async function beginTransport(transport: GoogleLiveRealtimeTalkTransport): Promise<{
  start: Promise<"ready" | "cancelled">;
  ws: FakeGoogleLiveWebSocket;
}> {
  const start = transport.start();
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeGoogleLiveWebSocket.instance;
  if (!ws) {
    throw new Error("missing Google Live WebSocket");
  }
  return { start, ws };
}

async function startTransport(
  transport: GoogleLiveRealtimeTalkTransport,
): Promise<FakeGoogleLiveWebSocket> {
  const { start, ws } = await beginTransport(transport);
  ws.emitOpen();
  ws.emitMessage({ setupComplete: {} });
  await expect(start).resolves.toBe("ready");
  transport.activate();
  return ws;
}

describe("Google Live Video Talk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeGoogleLiveWebSocket.instance = undefined;
    vi.stubGlobal("WebSocket", FakeGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("streams bounded camera frames directly and answers describe_view calls", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const audioStop = audioTrack.stop;
    const videoStop = videoTrack.stop;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (element instanceof HTMLVideoElement) {
        Object.defineProperties(element, {
          readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
          videoWidth: { configurable: true, value: 1280 },
          videoHeight: { configurable: true, value: 720 },
        });
        vi.spyOn(element, "play").mockResolvedValue(undefined);
      }
      return element;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValueOnce(`data:image/jpeg;base64,${"x".repeat(600 * 1024)}`)
      .mockReturnValue("data:image/jpeg;base64,gemini-camera-frame");
    const onStatus = vi.fn();
    const onVideoStream = vi.fn();
    const transport = await createTransport({ onStatus, onVideoStream });

    const { start, ws } = await beginTransport(transport);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(onVideoStream).not.toHaveBeenCalled();
    await transport.setVideoEnabled(true);
    ws.emitOpen();
    ws.emitMessage({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");
    expect(ws.sent.some((message) => JSON.stringify(message).includes('"video"'))).toBe(false);
    transport.activate();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.sent).toContainEqual({
      realtimeInput: {
        video: { data: "gemini-camera-frame", mimeType: "image/jpeg" },
      },
    });
    for (const message of ws.sent) {
      expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(
        512 * 1024,
      );
    }
    ws.emitMessage({
      toolCall: {
        functionCalls: [
          { id: "call-camera", name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, args: {} },
        ],
      },
    });
    await Promise.resolve();
    expect(ws.sent).toContainEqual({
      toolResponse: {
        functionResponses: [
          {
            id: "call-camera",
            name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
            response: { ok: true, cameraStreamActive: true },
          },
        ],
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
    expect(onVideoStream).toHaveBeenCalledWith(camera);
    expect(onStatus).toHaveBeenCalledWith("listening");

    const countVideoMessages = () =>
      ws.sent.filter((message) => JSON.stringify(message).includes('"video"')).length;
    expect(countVideoMessages()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(countVideoMessages()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(countVideoMessages()).toBe(2);

    await transport.setVideoEnabled(false);
    expect(videoStop).toHaveBeenCalledOnce();
    expect(audioStop).not.toHaveBeenCalled();
    ws.emitMessage({
      toolCall: {
        functionCalls: [
          { id: "call-ended-camera", name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, args: {} },
        ],
      },
    });
    await Promise.resolve();
    expect(ws.sent).toContainEqual({
      toolResponse: {
        functionResponses: [
          {
            id: "call-ended-camera",
            name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
            response: {
              ok: false,
              error: "camera is off",
            },
          },
        ],
      },
    });

    const sentBeforeStop = ws.sent.length;
    transport.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ws.sent).toHaveLength(sentBeforeStop);
    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    expect(audioStop).toHaveBeenCalledOnce();
    expect(videoStop).toHaveBeenCalledOnce();
  });

  it("finishes active camera cleanup when the stream callback throws", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const audioStop = audioTrack.stop;
    const videoStop = videoTrack.stop;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn((stream: MediaStream | null) => {
      if (!stream) {
        throw new Error("stream callback failed");
      }
    });
    const transport = await createTransport({ onVideoStream });
    const ws = await startTransport(transport);
    await transport.setVideoEnabled(true);

    expect(() => transport.stop()).toThrow("stream callback failed");
    expect(audioStop).toHaveBeenCalledOnce();
    expect(videoStop).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(3);
  });

  it.each(["resolved", "rejected"])(
    "keeps one current capture loop when the previous camera frame is %s after a switch",
    async (outcome) => {
      const { stream: audio } = audioFixture();
      const { track: frontTrack, stream: frontCamera } = cameraFixture("front");
      const { stream: backCamera } = cameraFixture("back");
      const frontStop = frontTrack.stop;
      const getUserMedia = vi
        .fn()
        .mockResolvedValueOnce(audio)
        .mockResolvedValueOnce(frontCamera)
        .mockResolvedValueOnce(backCamera);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      const videos: HTMLVideoElement[] = [];
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const element = originalCreateElement(tagName);
        if (element instanceof HTMLVideoElement) {
          videos.push(element);
          Object.defineProperties(element, {
            readyState: {
              configurable: true,
              value:
                videos.length === 1
                  ? HTMLMediaElement.HAVE_NOTHING
                  : HTMLMediaElement.HAVE_CURRENT_DATA,
            },
            videoWidth: { configurable: true, value: 1280 },
            videoHeight: { configurable: true, value: 720 },
          });
          vi.spyOn(element, "play").mockResolvedValue(undefined);
        }
        return element;
      });
      let capturedVideo: HTMLVideoElement | undefined;
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage: (video: HTMLVideoElement) => {
          capturedVideo = video;
        },
      } as never);
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
        () =>
          `data:image/jpeg;base64,${capturedVideo === videos[0] ? "front-frame" : "back-frame"}`,
      );
      const onVideoStream = vi.fn();
      const onStatus = vi.fn();
      const transport = await createTransport({ onVideoStream, onStatus }, "front");

      const ws = await startTransport(transport);
      await transport.setVideoEnabled(true);
      await vi.advanceTimersByTimeAsync(0);
      await transport.switchCamera("back");
      await vi.advanceTimersByTimeAsync(0);

      expect(getUserMedia).toHaveBeenNthCalledWith(2, {
        video: { deviceId: { exact: "front" } },
      });
      expect(getUserMedia).toHaveBeenNthCalledWith(3, {
        video: { deviceId: { exact: "back" } },
      });
      expect(frontStop).toHaveBeenCalledOnce();
      expect(onVideoStream).toHaveBeenLastCalledWith(backCamera);

      Object.defineProperties(videos[0]!, {
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        videoWidth: { configurable: true, value: outcome === "resolved" ? 1280 : 0 },
      });
      videos[0]!.dispatchEvent(new Event("loadeddata"));
      await vi.advanceTimersByTimeAsync(1_000);
      const frames = ws.sent.filter((message) => JSON.stringify(message).includes('"video"'));
      expect(frames).toEqual(
        Array.from({ length: 2 }, () => ({
          realtimeInput: { video: { data: "back-frame", mimeType: "image/jpeg" } },
        })),
      );
      expect(onStatus.mock.calls.some(([status]) => status === "error")).toBe(false);
      transport.stop();
    },
  );

  it("releases camera media when Google setup times out", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const audioStop = audioTrack.stop;
    const videoStop = videoTrack.stop;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (element instanceof HTMLVideoElement) {
        vi.spyOn(element, "play").mockResolvedValue(undefined);
      }
      return element;
    });
    const onStatus = vi.fn();
    const onVideoStream = vi.fn();
    const transport = await createTransport({ onStatus, onVideoStream });

    const { start, ws } = await beginTransport(transport);
    onStatus.mockClear();
    await transport.setVideoEnabled(true);
    ws.emitOpen();
    const rejected = expect(start).rejects.toThrow("Realtime connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30_000);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(audioStop).toHaveBeenCalledOnce();
    expect(videoStop).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
    expect(onVideoStream).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(3);
  });
});
