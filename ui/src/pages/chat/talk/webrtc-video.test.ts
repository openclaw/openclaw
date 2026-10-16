// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import type { RealtimeTalkCallbacks } from "./shared.ts";
import {
  dispatchRealtimeEvent,
  FakePeerConnection,
  requirePeer,
  sentRealtimeEvents,
} from "./webrtc.test-support.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./webrtc.ts";

class VideoPeerConnection extends FakePeerConnection {
  readonly sctp = { maxMessageSize: 512 };
}

async function createTransport(callbacks: RealtimeTalkCallbacks = {}, videoDeviceId?: string) {
  const context = {
    input: await prepareRealtimeTalkTestInput(),
    client: {} as never,
    sessionKey: "main",
    callbacks,
    videoDeviceId,
  };
  const transport = new WebRtcSdpRealtimeTalkTransport(
    { provider: "openai", transport: "webrtc", clientSecret: "test-client-secret" },
    context,
  );
  return { transport, context };
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
    ...(deviceId ? { getSettings: () => ({ deviceId }) } : {}),
  });
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

function dispatchDescribeViewToolCall(
  peer: FakePeerConnection | undefined,
  ids: { itemId: string; callId: string },
): void {
  dispatchRealtimeEvent(peer, {
    type: "response.done",
    response: {
      id: `response-${ids.callId}`,
      status: "completed",
      output: [
        {
          type: "function_call",
          status: "completed",
          id: ids.itemId,
          call_id: ids.callId,
          name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
          arguments: "{}",
        },
      ],
    },
  });
}

describe("OpenAI Realtime media lifecycle", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", VideoPeerConnection);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ends the call visibly when the microphone track ends", async () => {
    const { track, stream } = audioFixture();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const onStatus = vi.fn();
    const { transport } = await createTransport({ onStatus });
    try {
      await transport.start();

      track.dispatchEvent(new Event("ended"));

      expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("Microphone"));
      expect(requirePeer().connectionState).toBe("closed");
      expect(track.stop).toHaveBeenCalledOnce();
      expect(document.querySelector("audio")).toBeNull();
    } finally {
      transport.stop();
    }
  });

  it("starts audio-only, toggles local camera, and reports camera-off tool calls", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const audioStop = audioTrack.stop;
    const videoStop = videoTrack.stop;
    const getUserMedia = vi.fn().mockResolvedValueOnce(audio).mockResolvedValueOnce(camera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const originalCreateElement = document.createElement.bind(document);
    let videoReadyState: number = HTMLMediaElement.HAVE_METADATA;
    let captureVideo: HTMLVideoElement | undefined;
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (element instanceof HTMLVideoElement) {
        captureVideo = element;
        Object.defineProperties(element, {
          readyState: { configurable: true, get: () => videoReadyState },
          videoWidth: { configurable: true, value: 1280 },
          videoHeight: { configurable: true, value: 720 },
        });
        vi.spyOn(element, "play").mockResolvedValue(undefined);
      }
      return element;
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValueOnce(`data:image/jpeg;base64,${"x".repeat(512)}`)
      .mockReturnValueOnce("data:image/jpeg;base64,camera-frame");
    const onVideoStream = vi.fn();
    const onTalkEvent = vi.fn();
    const onStatus = vi.fn();
    const { transport } = await createTransport({ onStatus, onTalkEvent, onVideoStream });

    await transport.start();
    const peer = requirePeer();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(peer?.addTrack).toHaveBeenCalledWith(audioTrack, audio);
    expect(onVideoStream).not.toHaveBeenCalled();

    await transport.setVideoEnabled(true);
    expect(onVideoStream).toHaveBeenCalledWith(camera);
    dispatchDescribeViewToolCall(peer, { itemId: "item-camera", callId: "call-camera" });
    await Promise.resolve();
    expect(sentRealtimeEvents(peer)).not.toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ content: expect.any(Array) }),
      }),
    );
    videoReadyState = HTMLMediaElement.HAVE_CURRENT_DATA;
    captureVideo?.dispatchEvent(new Event("loadeddata"));

    await vi.waitFor(() =>
      expect(sentRealtimeEvents(peer)).toContainEqual({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/jpeg;base64,camera-frame" }],
        },
      }),
    );
    expect(sentRealtimeEvents(peer)).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-camera",
        output: JSON.stringify({ ok: true, frameAttached: true }),
      },
    });
    expect(sentRealtimeEvents(peer)).toContainEqual({ type: "response.create" });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
    expect(peer?.addTrack).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toContain("tool.result");
    for (const [payload] of peer?.channel.send.mock.calls ?? []) {
      expect(new TextEncoder().encode(String(payload)).length).toBeLessThanOrEqual(512);
    }

    await transport.setVideoEnabled(false);
    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    expect(videoStop).toHaveBeenCalledOnce();
    expect(audioStop).not.toHaveBeenCalled();

    dispatchDescribeViewToolCall(peer, {
      itemId: "item-camera-off",
      callId: "call-camera-off",
    });
    await vi.waitFor(() =>
      expect(sentRealtimeEvents(peer)).toContainEqual({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-camera-off",
          output: JSON.stringify({ ok: false, error: "camera is off" }),
        },
      }),
    );
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

    transport.stop();
    expect(audioStop).toHaveBeenCalledOnce();
  });

  it("clears ended camera state and reacquires on the next enable", async () => {
    const { stream: audio } = audioFixture();
    const { track: firstVideoTrack, stream: firstCamera } = cameraFixture();
    const { stream: secondCamera } = cameraFixture();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(firstCamera)
      .mockResolvedValueOnce(secondCamera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn();
    const { transport } = await createTransport({ onVideoStream });

    await transport.start();
    await transport.setVideoEnabled(true);
    firstVideoTrack.dispatchEvent(new Event("ended"));

    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    await transport.setVideoEnabled(true);
    expect(getUserMedia).toHaveBeenNthCalledWith(3, { video: true });
    expect(onVideoStream).toHaveBeenLastCalledWith(secondCamera);

    transport.stop();
  });

  it("keeps voice alive when lazy camera acquisition fails", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const audioStop = audioTrack.stop;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const onStatus = vi.fn();
    const onVideoStream = vi.fn();
    const { transport } = await createTransport({ onStatus, onVideoStream });

    await transport.start();
    await expect(transport.setVideoEnabled(true)).rejects.toThrow("Camera access is blocked");

    expect(audioStop).not.toHaveBeenCalled();
    expect(onVideoStream).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    transport.stop();
    expect(audioStop).toHaveBeenCalledOnce();
  });

  it("releases acquired media when stopped during the camera prompt", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const cameraPending = createDeferred<MediaStream>();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockReturnValueOnce(cameraPending.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const { transport } = await createTransport();

    await transport.start();
    const enabling = transport.setVideoEnabled(true);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    transport.stop();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    cameraPending.resolve(camera);

    await expect(enabling).resolves.toBeUndefined();
    expect(videoTrack.stop).toHaveBeenCalledOnce();
  });

  it("switches an active camera and updates the capture stream", async () => {
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
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn();
    const { transport } = await createTransport({ onVideoStream }, "front");

    await transport.start();
    await transport.setVideoEnabled(true);
    await transport.switchCamera("back");

    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: { deviceId: { exact: "front" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      video: { deviceId: { exact: "back" } },
    });
    expect(frontStop).toHaveBeenCalledOnce();
    expect(onVideoStream).toHaveBeenLastCalledWith(backCamera);

    transport.stop();
  });

  it("restores the previous camera when a live switch fails", async () => {
    const { stream: audio } = audioFixture();
    const { stream: firstFrontCamera } = cameraFixture("front");
    const { stream: restoredFrontCamera } = cameraFixture("front");
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(firstFrontCamera)
      .mockRejectedValueOnce(new DOMException("missing", "OverconstrainedError"))
      .mockResolvedValueOnce(restoredFrontCamera);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const onVideoStream = vi.fn();
    const { transport, context } = await createTransport({ onVideoStream }, "front");

    await transport.start();
    await transport.setVideoEnabled(true);
    await expect(transport.switchCamera("missing")).rejects.toThrow(
      "The selected camera is unavailable",
    );

    expect(getUserMedia).toHaveBeenNthCalledWith(4, {
      video: { deviceId: { exact: "front" } },
    });
    expect(context.videoDeviceId).toBe("front");
    expect(onVideoStream).toHaveBeenLastCalledWith(restoredFrontCamera);

    transport.stop();
  });
});
