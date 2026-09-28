/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { OpenClawChatCameraCapture } from "./chat-camera-capture.ts";

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

describe("composer camera capture", () => {
  let component: OpenClawChatCameraCapture;
  let restoreDialog: () => void;
  let mediaDevicesDescriptor: PropertyDescriptor | undefined;
  let canvasContextDescriptor: PropertyDescriptor | undefined;
  let getUserMedia: ReturnType<
    typeof vi.fn<
      (constraints: MediaStreamConstraints) => Promise<ReturnType<typeof media>["stream"]>
    >
  >;
  let enumerateDevices: ReturnType<typeof vi.fn>;
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const createObjectURL = vi.fn(() => "blob:camera-test");
  const revokeObjectURL = vi.fn();

  async function settle() {
    await component.updateComplete;
    await Promise.resolve();
    await component.updateComplete;
  }

  function button(text: string) {
    const result = [...component.renderRoot.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    if (!result) {
      throw new Error(`Missing button: ${text}`);
    }
    return result;
  }

  beforeEach(async () => {
    restoreDialog = installDialogPolyfill();
    canvasContextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    getUserMedia =
      vi.fn<(constraints: MediaStreamConstraints) => Promise<ReturnType<typeof media>["stream"]>>();
    enumerateDevices = vi.fn(async () => []);
    mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices },
    });
    play = vi.fn(async () => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
    component = new OpenClawChatCameraCapture();
    component.onCapture = vi.fn();
    component.onUpload = vi.fn();
    component.onNativeCapture = vi.fn();
    component.readSignal = new AbortController().signal;
    document.body.append(component);
    await settle();
  });

  afterEach(async () => {
    component.remove();
    await settle();
    if (mediaDevicesDescriptor) {
      Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
    if (canvasContextDescriptor) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContextDescriptor);
    }
    restoreDialog();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("requests only the camera on demand and stops it on modal dismissal", async () => {
    const capture = media();
    getUserMedia.mockResolvedValue(capture.stream);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
    component.show();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    component.show();
    expect(getUserMedia).toHaveBeenCalledOnce();
    await settle();
    const video = component.renderRoot.querySelector("video");
    expect(video?.srcObject).toBe(capture.stream);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(video?.hasAttribute("muted")).toBe(true);
    expect(button("Capture").disabled).toBe(false);
    component.renderRoot
      .querySelector("openclaw-modal-dialog")
      ?.dispatchEvent(new CustomEvent("modal-cancel"));
    await settle();
    expect(capture.track.stop).toHaveBeenCalledOnce();
    expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it.each(["abort", "retarget", "disable", "disconnect", "pagehide"])(
    "releases an active camera on %s",
    async (action) => {
      const scope = new AbortController();
      component.readSignal = scope.signal;
      const capture = media();
      getUserMedia.mockResolvedValue(capture.stream);
      component.show();
      await settle();
      if (action === "abort") {
        scope.abort();
      }
      if (action === "retarget") {
        component.readSignal = new AbortController().signal;
      }
      if (action === "disable") {
        component.disabled = true;
      }
      if (action === "disconnect") {
        component.remove();
      }
      if (action === "pagehide") {
        window.dispatchEvent(new Event("pagehide"));
      }
      await settle();
      expect(capture.track.stop).toHaveBeenCalledOnce();
      expect(component.onCapture).not.toHaveBeenCalled();
      expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it("disposes a late permission grant without replacing a reopened preview", async () => {
    const oldCamera = media("old");
    const newCamera = media("new");
    const pending = createDeferred<typeof oldCamera.stream>();
    getUserMedia.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newCamera.stream);
    component.show();
    await settle();
    button("Cancel").click();
    component.show();
    await settle();
    pending.resolve(oldCamera.stream);
    await settle();
    expect(oldCamera.track.stop).toHaveBeenCalledOnce();
    expect(newCamera.track.stop).not.toHaveBeenCalled();
    expect(component.renderRoot.querySelector("video")?.srcObject).toBe(newCamera.stream);
  });

  it.each([
    ["NotAllowedError", "Camera access was denied"],
    ["NotFoundError", "No camera was found"],
    ["NotReadableError", "The camera could not start"],
  ])("reports %s and only uploads on explicit selection", async (name, copy) => {
    getUserMedia.mockRejectedValue(new DOMException("camera error", name));
    component.show();
    await settle();
    expect(component.renderRoot.querySelector("[role=alert]")?.textContent).toContain(copy);
    expect(component.onUpload).not.toHaveBeenCalled();
    expect(component.renderRoot.textContent).not.toContain("Use device camera");
    const onUpload = component.onUpload;
    button("Upload photo").click();
    await settle();
    expect(onUpload).toHaveBeenCalledOnce();
    expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it.each(["insecure", "unsupported"])(
    "offers native capture explicitly for %s contexts",
    async (kind) => {
      if (kind === "insecure") {
        vi.stubGlobal("isSecureContext", false);
      } else {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      }
      component.show();
      await settle();
      expect(component.renderRoot.textContent).toContain("camera or file picker");
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(component.onNativeCapture).not.toHaveBeenCalled();
      expect(component.onUpload).not.toHaveBeenCalled();
      const nativeCapture = component.onNativeCapture;
      button("Use device camera").click();
      await settle();
      expect(nativeCapture).toHaveBeenCalledExactlyOnceWith(component);
      expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it("does not open a native picker for a replaced draft", async () => {
    vi.stubGlobal("isSecureContext", false);
    component.show();
    await settle();
    const nativeCapture = component.onNativeCapture;
    component.readSignal = new AbortController().signal;
    button("Use device camera").click();
    expect(nativeCapture).not.toHaveBeenCalled();
    await settle();
    expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("keeps a stopped-camera error when an old play promise finishes", async () => {
    const capture = media();
    const playing = createDeferred();
    play.mockReturnValue(playing.promise);
    getUserMedia.mockResolvedValue(capture.stream);
    component.show();
    await settle();
    capture.track.dispatchEvent(new Event("ended"));
    playing.resolve();
    await settle();
    expect(component.renderRoot.querySelector("[role=alert]")?.textContent).toContain(
      "Your camera stopped",
    );
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
    component.show();
    await settle();
    const select = component.renderRoot.querySelector("select");
    if (!select) {
      throw new Error("Missing camera selector");
    }
    select.value = "back";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: "back" } },
    });
    expect(component.renderRoot.querySelector("video")?.srcObject).toBe(back.stream);
  });

  function encodeFrames() {
    const drawImage = vi.fn();
    const context = { drawImage };
    // Canvas rendering is covered by browser flow proof; here the boundary is encoding completion.
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => context),
    });
    return vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["camera frame"], { type: "image/jpeg" }));
    });
  }

  it("stops after capture, retakes, and publishes only the confirmed still", async () => {
    encodeFrames();
    const first = media();
    const second = media();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    component.show();
    await settle();
    button("Capture").click();
    await settle();
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(component.onCapture).not.toHaveBeenCalled();
    expect(component.renderRoot.querySelector("img")?.src).toBe("blob:camera-test");
    button("Retake").click();
    await settle();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:camera-test");
    button("Capture").click();
    await settle();
    const onCapture = component.onCapture;
    button("Use photo").click();
    await settle();
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image/jpeg",
        name: expect.stringMatching(/^camera-\d+\.jpg$/),
      }),
    );
    expect(second.track.stop).toHaveBeenCalledOnce();
    expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("ignores image encoding that finishes after the draft is replaced", async () => {
    const encoding = encodeFrames();
    let finish: BlobCallback | undefined;
    encoding.mockImplementation((callback) => {
      finish = callback;
    });
    const capture = media();
    getUserMedia.mockResolvedValue(capture.stream);
    component.show();
    await settle();
    button("Capture").click();
    expect(capture.track.stop).toHaveBeenCalledOnce();
    component.readSignal = new AbortController().signal;
    finish?.(new Blob(["late"], { type: "image/jpeg" }));
    await settle();
    expect(component.onCapture).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(component.renderRoot.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
