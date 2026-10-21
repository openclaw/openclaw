// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import {
  beginTimedTransport as beginTransport,
  startTimedTransport as startTransport,
  createTransport,
  toolResponse,
  installGoogleLiveTestFixture,
  expectAudioReleased,
  latestWebSocket,
} from "./google-live.test-support.ts";
import type { RealtimeTalkCallbacks } from "./shared.ts";

function mediaFixture(kind: "Audio" | "Video", deviceId?: string) {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    ...(kind === "Video" ? { readyState: "live", enabled: true, muted: false } : {}),
    ...(deviceId ? { getSettings: () => ({ deviceId }) } : {}),
  });
  const stream = {
    [`get${kind}Tracks`]: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

function cameraFixture(deviceId?: string) {
  return mediaFixture("Video", deviceId);
}

function audioFixture() {
  return mediaFixture("Audio");
}

function installMedia(...streams: MediaStream[]) {
  const getUserMedia = vi.fn();
  for (const stream of streams) {
    getUserMedia.mockResolvedValueOnce(stream);
  }
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

function mockVideoElements(readyState: (index: number) => number) {
  const videos: HTMLVideoElement[] = [];
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    const element = createElement(tagName);
    if (element instanceof HTMLVideoElement) {
      Object.defineProperties(element, {
        readyState: { configurable: true, value: readyState(videos.length) },
        videoWidth: { configurable: true, value: 1280 },
        videoHeight: { configurable: true, value: 720 },
      });
      videos.push(element);
      vi.spyOn(element, "play").mockResolvedValue(undefined);
    }
    return element;
  });
  return videos;
}

function createVideoTransport(callbacks: RealtimeTalkCallbacks, videoDeviceId?: string) {
  return createTransport(
    callbacks,
    { request: vi.fn(), addEventListener: vi.fn() } as never,
    undefined,
    { clientSecret: ["auth_tokens", "browser-video-test"].join("/") },
    videoDeviceId,
  );
}

async function expectDescribeView(
  ws: ReturnType<typeof latestWebSocket>,
  id: string,
  response: object,
) {
  ws.emitCalls({ id, name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, args: {} });
  await Promise.resolve();
  expect(ws.messages).toContainEqual(
    toolResponse(id, REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, response),
  );
}

function videoMessages(ws: ReturnType<typeof latestWebSocket>) {
  return ws.messages.filter((message) => JSON.stringify(message).includes('"video"'));
}

describe("Google Live Video Talk", () => {
  installGoogleLiveTestFixture();
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["unchanged", "muted", "track-disabled"] as const)(
    "keeps camera frames usable through readiness: %s",
    async (change) => {
      const { track: audioTrack, stream: audio } = audioFixture();
      const { track: videoTrack, stream: camera } = cameraFixture();
      const getUserMedia = installMedia(audio, camera);

      const videos = mockVideoElements(() => HTMLMediaElement.HAVE_METADATA);
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage: vi.fn(),
      } as never);
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
        .mockReturnValueOnce(`data:image/jpeg;base64,${"x".repeat(600 * 1024)}`)
        .mockReturnValue("data:image/jpeg;base64,gemini-camera-frame");
      const onStatus = vi.fn();
      const onVideoStream = vi.fn();
      const transport = await createVideoTransport({ onStatus, onVideoStream });

      const { start, ws } = await beginTransport(transport);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(onVideoStream).not.toHaveBeenCalled();
      await transport.setVideoEnabled(true);
      ws.emitOpen();
      ws.emitJson({ setupComplete: {} });
      await expect(start).resolves.toBe("ready");
      expect(videoMessages(ws)).toEqual([]);
      transport.activate();
      await vi.advanceTimersByTimeAsync(0);
      if (change === "muted") {
        videoTrack.muted = true;
        videoTrack.dispatchEvent(new Event("mute"));
      } else if (change === "track-disabled") {
        videoTrack.enabled = false;
      }
      Object.defineProperty(videos[0]!, "readyState", {
        configurable: true,
        value: HTMLMediaElement.HAVE_CURRENT_DATA,
      });
      videos[0]!.dispatchEvent(new Event("loadeddata"));
      await vi.advanceTimersByTimeAsync(0);
      if (change !== "unchanged") {
        expect(onVideoStream).toHaveBeenLastCalledWith(camera);
        expect(videoMessages(ws)).toEqual([]);
        videoTrack.muted = false;
        videoTrack.enabled = true;
        videoTrack.dispatchEvent(new Event("unmute"));
        await vi.advanceTimersByTimeAsync(999);
        expect(videoMessages(ws)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(ws.messages).toContainEqual({
        realtimeInput: {
          video: { data: "gemini-camera-frame", mimeType: "image/jpeg" },
        },
      });
      for (const message of ws.messages) {
        expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(
          512 * 1024,
        );
      }
      await expectDescribeView(ws, "call-camera", { ok: true, cameraStreamActive: true });
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

      expect(videoMessages(ws).length).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(videoMessages(ws).length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(videoMessages(ws).length).toBe(2);

      await transport.setVideoEnabled(false);
      expect(videoTrack.stop).toHaveBeenCalledOnce();
      expect(audioTrack.stop).not.toHaveBeenCalled();
      await expectDescribeView(ws, "call-ended-camera", { ok: false, error: "camera is off" });

      const sentBeforeStop = ws.messages.length;
      transport.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ws.messages).toHaveLength(sentBeforeStop);
      expect(onVideoStream).toHaveBeenLastCalledWith(null);
      expect(audioTrack.stop).toHaveBeenCalledOnce();
      expect(videoTrack.stop).toHaveBeenCalledOnce();
    },
  );

  it("finishes active camera cleanup when the stream callback throws", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    installMedia(audio, camera);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn((stream: MediaStream | null) => {
      if (!stream) {
        throw new Error("stream callback failed");
      }
    });
    const transport = await createVideoTransport({ onVideoStream });
    const ws = await startTransport(transport);
    await transport.setVideoEnabled(true);

    expect(() => transport.stop()).toThrow("stream callback failed");
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(3);
  });

  it.each(["resolved", "rejected"])(
    "keeps one current capture loop when the previous camera frame is %s after a switch",
    async (outcome) => {
      const { stream: audio } = audioFixture();
      const { track: frontTrack, stream: frontCamera } = cameraFixture("front");
      const { stream: backCamera } = cameraFixture("back");
      const getUserMedia = installMedia(audio, frontCamera, backCamera);
      const videos = mockVideoElements((index) =>
        index === 0 ? HTMLMediaElement.HAVE_NOTHING : HTMLMediaElement.HAVE_CURRENT_DATA,
      );
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
      const transport = await createVideoTransport({ onVideoStream, onStatus }, "front");

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
      expect(frontTrack.stop).toHaveBeenCalledOnce();
      expect(onVideoStream).toHaveBeenLastCalledWith(backCamera);

      Object.defineProperties(videos[0]!, {
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
        videoWidth: { configurable: true, value: outcome === "resolved" ? 1280 : 0 },
      });
      videos[0]!.dispatchEvent(new Event("loadeddata"));
      await vi.advanceTimersByTimeAsync(1_000);
      const frames = videoMessages(ws);
      expect(frames).toEqual(
        Array.from({ length: 2 }, () => ({
          realtimeInput: { video: { data: "back-frame", mimeType: "image/jpeg" } },
        })),
      );
      expect(onStatus.mock.calls.some(([status]) => status === "error")).toBe(false);
      transport.stop();
    },
  );

  const SETUP_TIMEOUT_MS = 30_000;
  it.each(["open", "connecting", "camera", "close", "error"])(
    "releases failed %s setup without provisional callbacks",
    async (state) => {
      const onStatus = vi.fn();
      const onVideoStream = vi.fn();
      const { track: audioTrack, stream: audio } = audioFixture();
      const { track: videoTrack, stream: camera } = cameraFixture();
      const getUserMedia = state === "camera" ? installMedia(audio, camera) : undefined;
      if (state === "camera") {
        vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      }
      const onTalkEvent = vi.fn(() => {
        throw new Error("talk callback must remain provisional");
      });
      const transport = await createTransport({ onStatus, onTalkEvent, onVideoStream });
      const { start, ws: socket } = await beginTransport(transport);
      onStatus.mockClear();
      if (state === "camera") {
        await transport.setVideoEnabled(true);
        expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
      }
      if (state === "open" || state === "camera") {
        socket.emitOpen();
      } else if (state === "connecting") {
        socket.readyState = 0;
        onStatus.mockImplementation(() => {
          throw new Error("status callback must remain provisional");
        });
      }
      const detail =
        state === "close"
          ? "Realtime connection closed"
          : state === "error"
            ? "Realtime connection failed"
            : "Realtime connection timed out after 30000ms";
      const rejected = expect(start).rejects.toThrow(detail);
      if (state === "close") {
        socket.emitClose();
      } else if (state === "error") {
        socket.emitError();
      } else {
        await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
      }
      await rejected;
      expect(onStatus).not.toHaveBeenCalled();
      expect(onTalkEvent).not.toHaveBeenCalled();
      if (state === "camera") {
        expect(audioTrack.stop).toHaveBeenCalledOnce();
        expect(videoTrack.stop).toHaveBeenCalledOnce();
        expect(onVideoStream).not.toHaveBeenCalled();
      } else {
        expectAudioReleased();
      }
      expect(socket.readyState).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("releases resources when a readiness callback throws during activation", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, ws: socket } = await beginTransport(transport);
    onStatus.mockClear();
    onStatus.mockImplementation(() => {
      throw new Error("consumer failed");
    });
    socket.emitOpen();
    socket.emitJson({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");

    expect(() => transport.activate()).toThrow("consumer failed");
    expectAudioReleased();
    expect(socket.readyState).toBe(3);
  });

  it("clears the deadline after Google setup completes", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start, ws: socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.emitOpen();
    socket.emitJson({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");
    expect(onStatus).not.toHaveBeenCalled();
    transport.activate();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith("listening");
    transport.stop();
  });

  it("clears the deadline when the transport stops", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start } = await beginTransport(transport);
    onStatus.mockClear();
    transport.stop();
    await expect(start).resolves.toBe("cancelled");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
