// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { RealtimeTalkCallbacks } from "./shared.ts";
import {
  audioFixture,
  createWebRtcTransport,
  dispatchCompletedToolCall,
  FakePeerConnection,
  requirePeer,
  sentRealtimeEvents,
  stubMedia,
  toolOutput,
  userMessage,
} from "./webrtc.test-support.ts";

class VideoPeerConnection extends FakePeerConnection {
  readonly sctp = { maxMessageSize: 512 };
}

async function createTransport(callbacks: RealtimeTalkCallbacks = {}, videoDeviceId?: string) {
  const fixture = await createWebRtcTransport({ callbacks, videoDeviceId });
  onTestFinished(() => fixture.transport.stop());
  return fixture;
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

function dispatchDescribeViewToolCall(
  peer: FakePeerConnection | undefined,
  suffix = "camera",
): void {
  dispatchCompletedToolCall(peer, {
    responseId: `response-call-${suffix}`,
    itemId: `item-${suffix}`,
    callId: `call-${suffix}`,
    name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
    arguments: "{}",
  });
}

async function startCamera(videoDeviceId?: string) {
  const { stream: audio } = audioFixture();
  const camera = cameraFixture(videoDeviceId);
  const getUserMedia = stubMedia(audio, camera.stream);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const onVideoStream = vi.fn();
  const fixture = await createTransport({ onVideoStream }, videoDeviceId);
  await fixture.transport.start();
  await fixture.transport.setVideoEnabled(true);
  return { ...fixture, camera, getUserMedia, onVideoStream };
}

const CAPTURE_CHANGES = ["unchanged", "disabled", "switched", "muted", "ended", "stopped"] as const;

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
    stubMedia(stream);
    const onStatus = vi.fn();
    const { transport } = await createTransport({ onStatus });
    await transport.start();

    track.dispatchEvent(new Event("ended"));

    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("Microphone"));
    expect(requirePeer().connectionState).toBe("closed");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(document.querySelector("audio")).toBeNull();
  });

  it.each(CAPTURE_CHANGES)("keeps camera consent through capture readiness: %s", async (change) => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const getUserMedia = stubMedia(audio, camera, cameraFixture("back").stream);

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
    const sent = () => sentRealtimeEvents(peer);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(peer?.addTrack).toHaveBeenCalledWith(audioTrack, audio);
    expect(onVideoStream).not.toHaveBeenCalled();

    await transport.setVideoEnabled(true);
    expect(onVideoStream).toHaveBeenCalledWith(camera);
    dispatchDescribeViewToolCall(peer);
    await Promise.resolve();
    expect(sent()).not.toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ content: expect.any(Array) }),
      }),
    );
    if (change !== "unchanged") {
      const pendingVideo = captureVideo;
      if (change === "disabled") {
        await transport.setVideoEnabled(false);
      } else if (change === "switched") {
        await transport.switchCamera("back");
      } else if (change === "muted") {
        videoTrack.muted = true;
      } else if (change === "ended") {
        videoTrack.dispatchEvent(new Event("ended"));
      } else {
        transport.stop();
      }
      const sentBeforeRelease = sent();
      const noticesBeforeRelease = onTalkEvent.mock.calls.length;
      // A detached preview may retain its decoded frame while the current camera changes.
      videoReadyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      pendingVideo?.dispatchEvent(new Event("loadeddata"));
      await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      const events = sent();
      expect(events.filter(({ item }) => item?.type === "message")).toEqual([]);
      if (change === "stopped") {
        expect(events).toEqual(sentBeforeRelease);
        expect(onTalkEvent).toHaveBeenCalledTimes(noticesBeforeRelease);
      } else {
        expect(events).toContainEqual(
          toolOutput("call-camera", { ok: false, error: "camera is off" }),
        );
      }
      return;
    }
    videoReadyState = HTMLMediaElement.HAVE_CURRENT_DATA;
    captureVideo?.dispatchEvent(new Event("loadeddata"));

    await vi.waitFor(() =>
      expect(sent()).toContainEqual(
        userMessage([{ type: "input_image", image_url: "data:image/jpeg;base64,camera-frame" }]),
      ),
    );
    expect(sent()).toContainEqual(toolOutput("call-camera", { ok: true, frameAttached: true }));
    expect(sent()).toContainEqual({ type: "response.create" });
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
    for (const [payload] of peer?.channel.send.mock.calls ?? []) {
      expect(new TextEncoder().encode(String(payload)).length).toBeLessThanOrEqual(512);
    }

    await transport.setVideoEnabled(false);
    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(audioTrack.stop).not.toHaveBeenCalled();

    dispatchDescribeViewToolCall(peer, "camera-off");
    await vi.waitFor(() =>
      expect(sent()).toContainEqual(
        toolOutput("call-camera-off", { ok: false, error: "camera is off" }),
      ),
    );
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

    transport.stop();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
  });

  it("clears ended camera state and reacquires on the next enable", async () => {
    const { transport, camera, getUserMedia, onVideoStream } = await startCamera();
    const { stream: secondCamera } = cameraFixture();
    getUserMedia.mockResolvedValueOnce(secondCamera);

    camera.track.dispatchEvent(new Event("ended"));

    expect(onVideoStream).toHaveBeenLastCalledWith(null);
    await transport.setVideoEnabled(true);
    expect(getUserMedia).toHaveBeenNthCalledWith(3, { video: true });
    expect(onVideoStream).toHaveBeenLastCalledWith(secondCamera);
  });

  it("keeps voice alive when lazy camera acquisition fails", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    stubMedia(audio).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const onStatus = vi.fn();
    const onVideoStream = vi.fn();
    const { transport } = await createTransport({ onStatus, onVideoStream });

    await transport.start();
    await expect(transport.setVideoEnabled(true)).rejects.toThrow("Camera access is blocked");

    expect(audioTrack.stop).not.toHaveBeenCalled();
    expect(onVideoStream).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    transport.stop();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
  });

  it("releases acquired media when stopped during the camera prompt", async () => {
    const { track: audioTrack, stream: audio } = audioFixture();
    const { track: videoTrack, stream: camera } = cameraFixture();
    const cameraPending = createDeferred<MediaStream>();
    const getUserMedia = stubMedia(audio).mockReturnValueOnce(cameraPending.promise);
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
    const { transport, camera, getUserMedia, onVideoStream } = await startCamera("front");
    const { stream: backCamera } = cameraFixture("back");
    getUserMedia.mockResolvedValueOnce(backCamera);

    await transport.switchCamera("back");

    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: { deviceId: { exact: "front" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      video: { deviceId: { exact: "back" } },
    });
    expect(camera.track.stop).toHaveBeenCalledOnce();
    expect(onVideoStream).toHaveBeenLastCalledWith(backCamera);
  });

  it("restores the previous camera when a live switch fails", async () => {
    const { transport, context, getUserMedia, onVideoStream } = await startCamera("front");
    const { stream: restoredFrontCamera } = cameraFixture("front");
    getUserMedia
      .mockRejectedValueOnce(new DOMException("missing", "OverconstrainedError"))
      .mockResolvedValueOnce(restoredFrontCamera);

    await expect(transport.switchCamera("missing")).rejects.toThrow(
      "The selected camera is unavailable",
    );

    expect(getUserMedia).toHaveBeenNthCalledWith(4, {
      video: { deviceId: { exact: "front" } },
    });
    expect(context.videoDeviceId).toBe("front");
    expect(onVideoStream).toHaveBeenLastCalledWith(restoredFrontCamera);
  });
});
