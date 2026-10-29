// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import {
  beginFakeTimedTransport as beginTransport,
  createSession,
  installGoogleLiveTestFixture,
  latestWebSocket,
} from "./google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import {
  audioFixture,
  cameraFixture,
  prepareRealtimeTalkTestInput,
  stubMedia as installMedia,
} from "./input.test-support.ts";
import type { RealtimeTalkCallbacks } from "./shared.ts";

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

async function createTransport(callbacks: RealtimeTalkCallbacks, videoDeviceId?: string) {
  return new GoogleLiveRealtimeTalkTransport(
    createSession(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
      ["auth_tokens", "browser-video-test"].join("/"),
    ),
    {
      input: await prepareRealtimeTalkTestInput(),
      callbacks,
      client: { request: vi.fn(), addEventListener: vi.fn() } as never,
      sessionKey: "main",
      videoDeviceId,
    },
  );
}

async function startTransport(
  transport: GoogleLiveRealtimeTalkTransport,
): Promise<ReturnType<typeof latestWebSocket>> {
  const { start, ws } = await beginTransport(transport);
  ws.emitOpen();
  ws.emitJson({ setupComplete: {} });
  await expect(start).resolves.toBe("ready");
  transport.activate();
  return ws;
}

async function expectDescribeView(
  ws: ReturnType<typeof latestWebSocket>,
  id: string,
  response: object,
) {
  ws.emitJson({
    toolCall: { functionCalls: [{ id, name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, args: {} }] },
  });
  await Promise.resolve();
  expect(ws.messages).toContainEqual({
    toolResponse: {
      functionResponses: [{ id, name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME, response }],
    },
  });
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
      const audioStop = audioTrack.stop;
      const videoStop = videoTrack.stop;
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
      const transport = await createTransport({ onStatus, onVideoStream });

      const { start, ws } = await beginTransport(transport);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(onVideoStream).not.toHaveBeenCalled();
      await transport.setVideoEnabled(true);
      ws.emitOpen();
      ws.emitJson({ setupComplete: {} });
      await expect(start).resolves.toBe("ready");
      expect(ws.messages.some((message) => JSON.stringify(message).includes('"video"'))).toBe(
        false,
      );
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
        expect(ws.messages.some((message) => JSON.stringify(message).includes('"video"'))).toBe(
          false,
        );
        videoTrack.muted = false;
        videoTrack.enabled = true;
        videoTrack.dispatchEvent(new Event("unmute"));
        await vi.advanceTimersByTimeAsync(999);
        expect(ws.messages.some((message) => JSON.stringify(message).includes('"video"'))).toBe(
          false,
        );
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

      const countVideoMessages = () =>
        ws.messages.filter((message) => JSON.stringify(message).includes('"video"')).length;
      expect(countVideoMessages()).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(countVideoMessages()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(countVideoMessages()).toBe(2);

      await transport.setVideoEnabled(false);
      expect(videoStop).toHaveBeenCalledOnce();
      expect(audioStop).not.toHaveBeenCalled();
      await expectDescribeView(ws, "call-ended-camera", { ok: false, error: "camera is off" });

      const sentBeforeStop = ws.messages.length;
      transport.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ws.messages).toHaveLength(sentBeforeStop);
      expect(onVideoStream).toHaveBeenLastCalledWith(null);
      expect(audioStop).toHaveBeenCalledOnce();
      expect(videoStop).toHaveBeenCalledOnce();
    },
  );

  it("finishes active camera cleanup when the stream callback throws", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const audioStop = audioTrack.stop;
    const videoStop = videoTrack.stop;
    installMedia(audio, camera);
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
      const frames = ws.messages.filter((message) => JSON.stringify(message).includes('"video"'));
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
    const getUserMedia = installMedia(audio, camera);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
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
