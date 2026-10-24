/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { OpenClawChatCameraCapture } from "./chat-camera-capture.tsx";
import "./chat-camera-capture.tsx";

function media(deviceId = "front") {
  const track = Object.assign(new EventTarget(), {
    readyState: "live",
    getSettings: () => ({ deviceId }),
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}
type CameraStream = ReturnType<typeof media>["stream"];

describe("composer camera capture", () => {
  let component: OpenClawChatCameraCapture;
  let restoreDialog: () => void;
  const restorers: (() => void)[] = [];
  let getUserMedia: ReturnType<
    typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<CameraStream>>
  >;
  let enumerateDevices: ReturnType<typeof vi.fn>;
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const createObjectURL = vi.fn(() => "blob:camera-test");
  const revokeObjectURL = vi.fn();
  const destinations = { onCapture: vi.fn(), onUpload: vi.fn(), onNativeCapture: vi.fn() };
  const modal = () => component.querySelector("openclaw-modal-dialog");

  function replaceProperty(target: object, key: PropertyKey, value: unknown) {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    restorers.push(() =>
      original ? Object.defineProperty(target, key, original) : Reflect.deleteProperty(target, key),
    );
  }

  async function settle() {
    await component.updateComplete;
    flush();
    await Promise.resolve();
    flush();
  }

  function button(text: string) {
    return [...component.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text,
    )!;
  }

  async function show() {
    component.show();
    await settle();
  }
  async function click(text: string) {
    button(text).click();
    await settle();
  }

  beforeEach(async () => {
    restoreDialog = installDialogPolyfill();
    vi.stubGlobal("isSecureContext", true);
    replaceProperty(URL, "createObjectURL", createObjectURL);
    replaceProperty(URL, "revokeObjectURL", revokeObjectURL);
    getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<CameraStream>>();
    enumerateDevices = vi.fn(async () => []);
    replaceProperty(navigator, "mediaDevices", { getUserMedia, enumerateDevices });
    play = vi.fn(async () => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
    component = document.createElement("openclaw-chat-camera-capture");
    Object.assign(component, destinations, { readSignal: new AbortController().signal });
    mountSolid(() => component);
    await settle();
  });

  afterEach(async () => {
    component.remove();
    await settle();
    for (const restore of restorers.splice(0).toReversed()) {
      restore();
    }
    restoreDialog();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(["modal-cancel", "abort", "retarget", "disable", "disconnect", "pagehide"] as const)(
    "requests the camera on demand and releases it on %s",
    async (action) => {
      const scope = new AbortController();
      component.readSignal = scope.signal;
      const capture = media();
      getUserMedia.mockResolvedValue(capture.stream);
      expect(getUserMedia).not.toHaveBeenCalled();
      component.show();
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      component.show();
      expect(getUserMedia).toHaveBeenCalledOnce();
      await settle();
      const video = component.querySelector("video");
      expect(video?.hasAttribute("playsinline")).toBe(true);
      expect(video?.hasAttribute("muted")).toBe(true);
      await waitForSolid(() => expect(button("Capture").disabled).toBe(false));
      const actions = {
        "modal-cancel": () => modal()?.dispatchEvent(new CustomEvent("modal-cancel")),
        abort: () => scope.abort(),
        retarget: () => Object.assign(component, { readSignal: new AbortController().signal }),
        disable: () => Object.assign(component, { disabled: true }),
        disconnect: () => component.remove(),
        pagehide: () => window.dispatchEvent(new Event("pagehide")),
      };
      actions[action]();
      await settle();
      expect(capture.track.stop).toHaveBeenCalledOnce();
      expect(destinations.onCapture).not.toHaveBeenCalled();
      expect(modal()).toBeNull();
    },
  );

  it("disposes a late permission grant without replacing a reopened preview", async () => {
    const oldCamera = media("old");
    const newCamera = media("new");
    const pending = createDeferred<typeof oldCamera.stream>();
    getUserMedia.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newCamera.stream);
    await show();
    button("Cancel").click();
    await show();
    pending.resolve(oldCamera.stream);
    await settle();
    expect(oldCamera.track.stop).toHaveBeenCalledOnce();
    expect(newCamera.track.stop).not.toHaveBeenCalled();
    expect(component.querySelector("video")?.srcObject).toBe(newCamera.stream);
  });

  it.each([
    ["NotFoundError", "No camera was found", "Upload photo"],
    ["SecurityError", "Camera access was denied", "Use device camera"],
    ["NotReadableError", "The camera could not start", "Use device camera"],
  ])("reports %s and offers explicit recovery through %s (%s)", async (name, copy, action) => {
    getUserMedia.mockRejectedValue(new DOMException("camera error", name));
    await show();
    expect(component.querySelector("[role=alert]")?.textContent).toContain(copy);
    expect(button("Try again").disabled).toBe(false);
    const destination =
      action === "Upload photo" ? destinations.onUpload : destinations.onNativeCapture;
    await click(action);
    expect(destination).toHaveBeenCalledExactlyOnceWith(component);
    expect(modal()).toBeNull();
  });

  it("does not open a native picker for a replaced draft", async () => {
    vi.stubGlobal("isSecureContext", false);
    await show();
    component.readSignal = new AbortController().signal;
    button("Use device camera").click();
    expect(destinations.onNativeCapture).not.toHaveBeenCalled();
    await settle();
    expect(modal()).toBeNull();
  });

  it("keeps a stopped-camera error when an old play promise finishes", async () => {
    const playing = createDeferred();
    play.mockReturnValue(playing.promise);
    const capture = media();
    getUserMedia.mockResolvedValue(capture.stream);
    await show();
    capture.track.dispatchEvent(new Event("ended"));
    playing.resolve();
    await settle();
    expect(component.querySelector("[role=alert]")?.textContent).toContain("Your camera stopped");
    expect(capture.track.stop).toHaveBeenCalledOnce();
  });

  it("switches cameras only after stopping the previous stream", async () => {
    const front = media("front");
    const back = media("back");
    enumerateDevices.mockResolvedValue([
      { kind: "videoinput", deviceId: "front", label: "Front camera" },
      { kind: "videoinput", deviceId: "back", label: "Back camera" },
    ]);
    getUserMedia.mockResolvedValueOnce(front.stream).mockImplementationOnce(async () => {
      expect(front.track.stop).toHaveBeenCalledOnce();
      return back.stream;
    });
    await show();
    const select = component.querySelector("select")!;
    select.value = "back";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: "back" } },
    });
    expect(component.querySelector("video")?.srcObject).toBe(back.stream);
  });

  function encodeFrames() {
    const context = { drawImage: vi.fn() };
    const getContext = vi.fn(() => context);
    replaceProperty(HTMLCanvasElement.prototype, "getContext", getContext);
    return vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["camera frame"], { type: "image/jpeg" }));
    });
  }

  it("revokes retaken previews and publishes the confirmed JPEG metadata", async () => {
    encodeFrames();
    getUserMedia.mockResolvedValueOnce(media().stream).mockResolvedValueOnce(media().stream);
    await show();
    await waitForSolid(() => expect(button("Capture").disabled).toBe(false));
    await click("Capture");
    expect(component.querySelector("img")?.src).toBe("blob:camera-test");
    await click("Retake");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:camera-test");
    await waitForSolid(() => expect(button("Capture").disabled).toBe(false));
    await click("Capture");
    await click("Use photo");
    expect(destinations.onCapture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "image/jpeg",
        name: expect.stringMatching(/^camera-\d+\.jpg$/),
      }),
    );
  });

  it("ignores image encoding that finishes after the draft is replaced", async () => {
    const encoding = encodeFrames();
    let finish: BlobCallback | undefined;
    encoding.mockImplementation((callback) => {
      finish = callback;
    });
    const capture = media();
    getUserMedia.mockResolvedValue(capture.stream);
    await show();
    await waitForSolid(() => expect(button("Capture").disabled).toBe(false));
    button("Capture").click();
    expect(capture.track.stop).toHaveBeenCalledOnce();
    component.readSignal = new AbortController().signal;
    finish?.(new Blob(["late"], { type: "image/jpeg" }));
    await settle();
    expect(destinations.onCapture).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
  });
});
