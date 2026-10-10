// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  openRealtimeTalkCamera,
  RealtimeTalkInputController,
} from "./input.ts";

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

function legacyWebKitOverconstrainedError(): Error & { constraint: string } {
  return Object.assign(new Error("Invalid constraint"), {
    name: "OverconstrainedError",
    constraint: "",
  });
}

function microphoneFixture() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const addEventListener = vi.spyOn(track, "addEventListener");
  return {
    track,
    addEventListener,
    stream: { getTracks: () => [track] } as unknown as MediaStream,
  };
}

function microphoneEndedListener(
  addEventListener: ReturnType<typeof microphoneFixture>["addEventListener"],
): EventListener {
  const listener = addEventListener.mock.calls.at(-1)?.[1];
  if (typeof listener !== "function") {
    throw new Error("expected microphone ended listener");
  }
  return listener;
}

const ownedInputs = new Set<RealtimeTalkInputController>();

function createMicrophoneInput(
  onEnded: (detail: string) => void = () => undefined,
  onConnecting?: (detail?: string) => void,
) {
  const input = new RealtimeTalkInputController(onEnded, onConnecting);
  ownedInputs.add(input);
  return input;
}

function openMicrophone(inputDeviceId: string | undefined) {
  return createMicrophoneInput().open(inputDeviceId);
}

afterEach(() => {
  ownedInputs.forEach((input) => input.stop());
  ownedInputs.clear();
  vi.unstubAllGlobals();
});

describe("realtime Talk microphone lifetime", () => {
  it("keeps a replacement input alive when a retired track reports ended", async () => {
    const previous = microphoneFixture();
    const replacement = microphoneFixture();
    const otherConsumer = vi.fn();
    previous.track.addEventListener("ended", otherConsumer);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(previous.stream)
          .mockResolvedValueOnce(replacement.stream),
      },
    });
    const onEnded = vi.fn();
    const input = createMicrophoneInput(onEnded);
    await input.open(undefined);
    const ended = microphoneEndedListener(previous.addEventListener);
    await input.open("replacement");

    ended(new Event("ended"));
    previous.track.dispatchEvent(new Event("ended"));
    expect(otherConsumer).toHaveBeenCalledOnce();
    expect(input.stream).toBe(replacement.stream);
    expect(previous.track.stop).toHaveBeenCalledOnce();
    expect(replacement.track.stop).not.toHaveBeenCalled();
    input.stop();
    expect(replacement.track.stop).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("cancels permission acquisition without retaining late microphone access", async () => {
    const { track, addEventListener, stream } = microphoneFixture();
    const media = createDeferred<MediaStream>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => media.promise) },
    });
    const onEnded = vi.fn();
    const onConnecting = vi.fn();
    const input = createMicrophoneInput(onEnded, onConnecting);
    const opening = input.open(undefined);
    expect(onConnecting).toHaveBeenCalledWith(expect.stringContaining("Waiting for microphone"));
    onConnecting.mockClear();
    input.stop();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });

    media.resolve(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(input.stream).toBeNull();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
    expect(onConnecting).not.toHaveBeenCalled();
  });
});

describe("realtime Talk microphone inputs", () => {
  it("lists unique audio inputs without probing during passive refresh", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("videoinput", "camera", "Camera"),
          mediaDevice("audioinput", "default", "Default - Built-in Microphone"),
          mediaDevice("audioinput", "built-in", "Built-in Microphone"),
          mediaDevice("audioinput", "usb", ""),
          mediaDevice("audioinput", "usb", "Duplicate"),
        ]),
        getUserMedia,
      },
    });

    await expect(discoverRealtimeTalkInputs(() => false)).resolves.toEqual({
      devices: [
        { deviceId: "built-in", label: "Built-in Microphone" },
        { deviceId: "usb", label: "Microphone 2" },
      ],
      permissionRequired: true,
      issue: null,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each([["UnknownError", "failed"]])(
    "reports microphone error %s as %s",
    async (errorName, expectedIssue) => {
      vi.stubGlobal("navigator", {
        mediaDevices: {
          enumerateDevices: vi.fn(async () => [mediaDevice("audioinput", "", "")]),
          getUserMedia: vi.fn(async () => {
            throw new DOMException("media request failed", errorName);
          }),
        },
      });

      const result = await discoverRealtimeTalkInputs(() => true);

      expect(result.devices).toEqual([]);
      expect(result.permissionRequired).toBe(true);
      expect(result.issue).toBe(expectedIssue);
    },
  );

  it("subscribes to devicechange and releases the listener on unsubscribe", () => {
    const mediaDevices = new EventTarget();
    let changes = 0;
    vi.stubGlobal("navigator", { mediaDevices });

    const unsubscribe = observeRealtimeTalkDevices(() => (changes += 1));
    mediaDevices.dispatchEvent(new Event("devicechange"));
    unsubscribe();
    mediaDevices.dispatchEvent(new Event("devicechange"));

    expect(changes).toBe(1);
  });

  it("stays inert where the browser exposes no media devices to watch", () => {
    vi.stubGlobal("navigator", {});
    expect(() => observeRealtimeTalkDevices(() => undefined)()).not.toThrow();
  });

  it("reports an unsupported enumeration instead of a generic access failure", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });

    await expect(discoverRealtimeTalkInputs(() => true)).resolves.toEqual({
      devices: [],
      permissionRequired: false,
      issue: "list-unsupported",
    });
  });

  it("reports microphone permission denial with actionable guidance", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(openMicrophone(undefined)).rejects.toThrow(
      "Microphone access is blocked. Allow it in browser site settings to list inputs.",
    );
  });

  it("rejects a legacy WebKit overconstraint without opening a different microphone", async () => {
    const fallback = microphoneFixture();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(legacyWebKitOverconstrainedError())
      .mockResolvedValueOnce(fallback.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("location", { host: "localhost", pathname: "/", protocol: "http:" });

    await expect(openMicrophone("selected-mic")).rejects.toThrow(
      "The selected microphone is unavailable",
    );
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "selected-mic" },
      },
    });
    expect(fallback.track.stop).not.toHaveBeenCalled();
  });

  it("does not request camera media after cancellation", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = new AbortController();
    controller.abort();

    await expect(
      openRealtimeTalkCamera(undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("releases media when cancellation follows browser permission resolution", async () => {
    const stop = vi.fn();
    const media = createDeferred<MediaStream>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => media.promise) },
    });
    const input = createMicrophoneInput();
    const opening = input.open(undefined);

    media.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    input.stop();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps cancellation precedence over a late media rejection", async () => {
    const media = createDeferred<MediaStream>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => media.promise) },
    });
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const opening = openRealtimeTalkCamera(undefined, { signal: controller.signal });

    controller.abort(reason);
    media.reject(new DOMException("denied", "NotAllowedError"));

    await expect(opening).rejects.toBe(reason);
  });
});

describe("realtime Talk camera inputs", () => {
  it("lists unique cameras in enumeration order with normalized labels", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          mediaDevice("audioinput", "mic", "Microphone"),
          mediaDevice("videoinput", "default", "Default Camera"),
          mediaDevice("videoinput", "front", "Front Camera"),
          mediaDevice("videoinput", "back", ""),
          mediaDevice("videoinput", "back", "Duplicate"),
        ]),
        getUserMedia,
      },
    });

    await expect(discoverRealtimeTalkCameras(() => false)).resolves.toEqual({
      devices: [
        { deviceId: "front", label: "Front Camera" },
        { deviceId: "back", label: "Camera 2" },
      ],
      permissionRequired: true,
      issue: null,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("probes video permission and re-enumerates hidden cameras", async () => {
    const stop = vi.fn();
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([mediaDevice("videoinput", "", "")])
      .mockResolvedValueOnce([mediaDevice("videoinput", "camera", "Desk Camera")]);
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices, getUserMedia } });

    await expect(discoverRealtimeTalkCameras(() => true)).resolves.toEqual({
      devices: [{ deviceId: "camera", label: "Desk Camera" }],
      permissionRequired: false,
      issue: null,
    });
    expect(getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });
});
