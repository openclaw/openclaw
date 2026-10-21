// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  openRealtimeTalkCamera,
  RealtimeTalkInputOwner,
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

function stubMediaDevices(devices: Partial<MediaDevices>) {
  vi.stubGlobal("navigator", { mediaDevices: devices });
}

function useMedia(result: MediaStream | Error) {
  const getUserMedia = vi.fn(async () => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  stubMediaDevices({ getUserMedia });
  return getUserMedia;
}

function pendingMedia() {
  const media = createDeferred<MediaStream>();
  const getUserMedia = vi.fn(() => media.promise);
  stubMediaDevices({ getUserMedia });
  return { ...media, getUserMedia };
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

const ownedInputs = new Set<RealtimeTalkInputOwner>();

function createMicrophoneInput(
  onEnded: (detail: string) => void = () => undefined,
  onConnecting?: (detail?: string) => void,
) {
  const input = new RealtimeTalkInputOwner(onEnded, onConnecting);
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
  it.each(["requesting", "acquired"])(
    "releases ownership if the %s status callback throws",
    async (phase) => {
      const { track, stream } = microphoneFixture();
      const getUserMedia = useMedia(stream);
      const input = createMicrophoneInput(undefined, (detail) => {
        if ((phase === "requesting") === Boolean(detail)) {
          throw new Error("status consumer failed");
        }
      });
      await expect(input.open(undefined)).rejects.toThrow("status consumer failed");
      expect(input.stream).toBeNull();
      expect(getUserMedia).toHaveBeenCalledTimes(phase === "requesting" ? 0 : 1);
      expect(track.stop).toHaveBeenCalledTimes(phase === "requesting" ? 0 : 1);
    },
  );

  it("releases input before a throwing microphone-loss callback", async () => {
    const { track, addEventListener, stream } = microphoneFixture();
    useMedia(stream);
    const onEnded = vi.fn(() => {
      expect(input.stream).toBeNull();
      expect(track.stop).toHaveBeenCalledOnce();
      throw new Error("consumer failed");
    });
    const input = createMicrophoneInput(onEnded);
    await input.open(undefined);
    const ended = microphoneEndedListener(addEventListener);

    expect(() => ended(new Event("ended"))).toThrow("consumer failed");
    expect(() => ended(new Event("ended"))).not.toThrow();
    input.stop();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    track.dispatchEvent(new Event("ended"));
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("keeps a replacement input alive when a retired track reports ended", async () => {
    const previous = microphoneFixture();
    const replacement = microphoneFixture();
    const otherConsumer = vi.fn();
    previous.track.addEventListener("ended", otherConsumer);
    stubMediaDevices({
      getUserMedia: vi
        .fn()
        .mockResolvedValueOnce(previous.stream)
        .mockResolvedValueOnce(replacement.stream),
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
    const media = pendingMedia();
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
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [
        mediaDevice("videoinput", "camera", "Camera"),
        mediaDevice("audioinput", "default", "Default - Built-in Microphone"),
        mediaDevice("audioinput", "built-in", "Built-in Microphone"),
        mediaDevice("audioinput", "usb", ""),
        mediaDevice("audioinput", "usb", "Duplicate"),
      ]),
      getUserMedia,
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

  it.each([
    ["audioinput", discoverRealtimeTalkInputs, { audio: true }],
    ["videoinput", discoverRealtimeTalkCameras, { video: true }],
  ] as const)(
    "probes %s permission, stops all tracks and re-enumerates",
    async (kind, discover, constraints) => {
      const stopFirst = vi.fn();
      const stopSecond = vi.fn();
      const enumerateDevices = vi
        .fn()
        .mockResolvedValueOnce([mediaDevice(kind, "", "")])
        .mockResolvedValueOnce([
          mediaDevice(kind, "built-in", "Built-in"),
          mediaDevice(kind, "external", "External"),
        ]);
      const getUserMedia = vi.fn(async () => ({
        getTracks: () => [{ stop: stopFirst }, { stop: stopSecond }],
      }));
      stubMediaDevices({ enumerateDevices, getUserMedia });

      await expect(discover(() => true)).resolves.toEqual({
        devices: [
          { deviceId: "built-in", label: "Built-in" },
          { deviceId: "external", label: "External" },
        ],
        permissionRequired: false,
        issue: null,
      });
      expect(getUserMedia).toHaveBeenCalledExactlyOnceWith(constraints);
      expect(stopFirst).toHaveBeenCalledOnce();
      expect(stopSecond).toHaveBeenCalledOnce();
      expect(enumerateDevices).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["NotAllowedError", "permission-blocked"],
    ["UnknownError", "failed"],
    ["constructor", "failed"],
    ["toString", "failed"],
    ["NotFoundError", "none-found"],
  ])("reports microphone error %s as %s", async (errorName, expectedIssue) => {
    stubMediaDevices({
      enumerateDevices: vi.fn(async () =>
        errorName === "NotFoundError" ? [] : [mediaDevice("audioinput", "", "")],
      ),
      getUserMedia: vi.fn(async () => {
        throw new DOMException("media request failed", errorName);
      }),
    });

    const result = await discoverRealtimeTalkInputs(() => true);

    expect(result).toEqual({
      devices: [],
      permissionRequired: true,
      issue: expectedIssue,
    });
  });

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

  it("reports an unsupported enumeration instead of a generic access failure", async () => {
    stubMediaDevices({});

    await expect(discoverRealtimeTalkInputs(() => true)).resolves.toEqual({
      devices: [],
      permissionRequired: false,
      issue: "list-unsupported",
    });
  });

  it.each([
    ["microphone", openMicrophone, legacyWebKitOverconstrainedError()],
    ["microphone", openMicrophone, new DOMException("missing", "OverconstrainedError")],
    ["camera", openRealtimeTalkCamera, legacyWebKitOverconstrainedError()],
  ] as const)("does not fall back from unavailable selected %s (%s)", async (kind, open, error) => {
    const fallback = microphoneFixture();
    const getUserMedia = useMedia(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(fallback.stream);
    if (kind === "microphone" && !(error instanceof DOMException)) {
      vi.stubGlobal("location", { host: "localhost", pathname: "/", protocol: "http:" });
    }
    await expect(open("selected")).rejects.toThrow(`The selected ${kind} is unavailable`);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith(
      kind === "camera"
        ? { video: { deviceId: { exact: "selected" } } }
        : {
            audio: {
              autoGainControl: true,
              echoCancellation: true,
              noiseSuppression: true,
              deviceId: { exact: "selected" },
            },
          },
    );
    expect(fallback.track.stop).not.toHaveBeenCalled();
  });

  it.each([
    [
      "microphone",
      openMicrophone,
      {
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          deviceId: { exact: "selected" },
        },
      },
    ],
    ["camera", openRealtimeTalkCamera, { video: { deviceId: { exact: "selected" } } }],
  ] as const)("uses exact %s selection and voice processing", async (_kind, open, constraints) => {
    const { stream } = microphoneFixture();
    const getUserMedia = useMedia(stream);
    await expect(open(" selected ")).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith(constraints);
  });

  it("does not request camera media after cancellation", async () => {
    const getUserMedia = vi.fn();
    stubMediaDevices({ getUserMedia });
    const controller = new AbortController();
    controller.abort();

    await expect(
      openRealtimeTalkCamera(undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("releases media when cancellation follows browser permission resolution", async () => {
    const { track, stream } = microphoneFixture();
    const media = pendingMedia();
    const input = createMicrophoneInput();
    const opening = input.open(undefined);

    media.resolve(stream);
    input.stop();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("keeps cancellation precedence over a late media rejection", async () => {
    const media = pendingMedia();
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const opening = openRealtimeTalkCamera(undefined, { signal: controller.signal });

    controller.abort(reason);
    media.reject(new DOMException("denied", "NotAllowedError"));

    await expect(opening).rejects.toBe(reason);
  });

  it.each([
    [
      openMicrophone,
      "Microphone access is blocked. Allow it in browser site settings to list inputs.",
    ],
    [
      openRealtimeTalkCamera,
      "Camera access is blocked. Allow camera access in browser site settings.",
    ],
  ] as const)("reports permission denial with actionable guidance", async (open, message) => {
    const cause = new DOMException("denied", "NotAllowedError");
    useMedia(cause);
    const opening = open(undefined);
    await expect(opening).rejects.toThrow(message);
    const error: unknown = await opening.catch((reason: unknown) => reason);
    expect(error).toHaveProperty("cause", cause);
    expect(formatUiError(error)).toBe(message);
  });

  it("reports a missing camera", async () => {
    useMedia(new DOMException("missing", "NotFoundError"));

    await expect(openRealtimeTalkCamera(undefined)).rejects.toThrow("No camera was found");
  });

  it("releases camera media when acquisition is cancelled", async () => {
    const { track, stream } = microphoneFixture();
    const pending = pendingMedia();
    const controller = new AbortController();

    const opening = openRealtimeTalkCamera(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(pending.getUserMedia).toHaveBeenCalledOnce());
    controller.abort();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  });
});
