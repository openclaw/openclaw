import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/modal-dialog.ts";
import { registerChatCameraEnglish } from "../../../i18n/locales/en-chat-camera.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { useNativeAttachmentCapture } from "./chat-attachment-picker-policy.ts";
import "./chat-camera-capture.css";

registerEnglishCatalog(registerChatCameraEnglish);
type CameraStage = "closed" | "requesting" | "live" | "capturing" | "review" | "error";
type CameraProps = {
  disabled: boolean;
  readSignal?: AbortSignal;
  onCapture?: (file: File) => void;
  onUpload?: (source: HTMLElement) => void;
  onNativeCapture?: (source: HTMLElement) => void;
};
export type OpenClawChatCameraCapture = SolidBridgeElement<CameraProps, { show(): void }>;
const openCameras = new WeakMap<OpenClawChatCameraCapture, () => void>();

/** One composer owns the camera, its pending permission request, and the chosen still. */
function CameraCaptureContent(props: CameraProps, host: OpenClawChatCameraCapture) {
  const [revision, setRevision] = createSignal(0);
  const state: {
    nativeFallback: boolean;
    stage: CameraStage;
    error: string;
    photoUrl: string;
    cameras: MediaDeviceInfo[];
    cameraId: string;
    videoReady: boolean;
  } = {
    nativeFallback: false,
    stage: "closed",
    error: "",
    photoUrl: "",
    cameras: [],
    cameraId: "",
    videoReady: false,
  };
  const publish = () => setRevision((value) => value + 1);
  const view = () => {
    revision();
    return state;
  };
  let generation = 0;
  let stream: MediaStream | undefined;
  let photo: File | undefined;
  let activeSignal: AbortSignal | undefined;
  let captureDestination: CameraProps["onCapture"];
  let uploadDestination: CameraProps["onUpload"];
  let nativeCaptureDestination: CameraProps["onNativeCapture"];
  let active = true;
  const isCurrent = (value: number) =>
    value === generation &&
    state.stage !== "closed" &&
    active &&
    host.isConnected &&
    !props.disabled &&
    activeSignal === props.readSignal &&
    !activeSignal?.aborted;
  const stopCamera = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    const video = host.querySelector("video");
    if (video) {
      video.srcObject = null;
    }
    state.videoReady = false;
  };
  const clearPhoto = () => {
    if (state.photoUrl) {
      URL.revokeObjectURL(state.photoUrl);
    }
    state.photoUrl = "";
    photo = undefined;
  };
  const releaseCamera = () => {
    generation += 1;
    stopCamera();
    clearPhoto();
    activeSignal?.removeEventListener("abort", close);
    activeSignal = undefined;
    captureDestination = uploadDestination = nativeCaptureDestination = undefined;
    state.stage = "closed";
  };
  const close = () => {
    releaseCamera();
    publish();
  };
  const fail = (message: string, nativeFallback = false) => {
    generation += 1;
    stopCamera();
    state.error = message;
    state.nativeFallback = nativeFallback;
    state.stage = "error";
    publish();
  };
  const listCameras = async (value: number) => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (isCurrent(value)) {
        state.cameras = devices.filter((device) => device.kind === "videoinput");
        publish();
      }
    } catch {
      // Device enumeration is optional; a usable preview must not depend on it.
    }
  };
  const startCamera = async () => {
    if (!isCurrent(generation)) {
      return;
    }
    const value = ++generation;
    stopCamera();
    clearPhoto();
    state.stage = "requesting";
    state.error = "";
    state.nativeFallback = false;
    publish();
    if (!globalThis.isSecureContext) {
      fail(t("chat.camera.insecure"), true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      fail(t("chat.camera.unsupported"), true);
      return;
    }
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: state.cameraId
          ? { deviceId: { exact: state.cameraId } }
          : { facingMode: { ideal: "environment" } },
      });
      // Permission prompts cannot be canceled. A late grant still belongs to the old draft.
      if (!isCurrent(value)) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = nextStream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") {
        fail(t("chat.camera.stopped"));
        return;
      }
      track.addEventListener(
        "ended",
        () => {
          if (isCurrent(value) && stream === nextStream) {
            fail(t("chat.camera.stopped"));
          }
        },
        { once: true },
      );
      state.cameraId = track.getSettings().deviceId ?? state.cameraId;
      void listCameras(value);
      await host.updateComplete;
      if (!isCurrent(value)) {
        return;
      }
      const video = host.querySelector("video");
      if (!video) {
        return;
      }
      video.srcObject = stream;
      await video.play();
      if (!isCurrent(value)) {
        return;
      }
      state.videoReady = video.videoWidth > 0 && video.videoHeight > 0;
      state.stage = "live";
      publish();
    } catch (error) {
      if (!isCurrent(value)) {
        return;
      }
      const name = error instanceof DOMException || error instanceof Error ? error.name : "";
      fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? t("chat.camera.permissionDenied")
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? t("chat.camera.notFound")
            : t("chat.camera.unavailable"),
      );
    }
  };
  const show = () => {
    if (
      !host.isConnected ||
      props.disabled ||
      props.readSignal?.aborted ||
      state.stage !== "closed"
    ) {
      return;
    }
    if (props.onNativeCapture && useNativeAttachmentCapture()) {
      props.onNativeCapture(host);
      return;
    }
    activeSignal = props.readSignal;
    activeSignal?.addEventListener("abort", close, { once: true });
    captureDestination = props.onCapture;
    uploadDestination = props.onUpload;
    nativeCaptureDestination = props.onNativeCapture;
    state.cameraId = "";
    state.cameras = [];
    state.stage = "requesting";
    // Keep getUserMedia in the menu's user gesture, before the first rendered frame.
    void startCamera();
  };
  const capture = async () => {
    const video = host.querySelector("video");
    const value = generation;
    if (!isCurrent(value) || state.stage !== "live" || !video?.videoWidth || !video.videoHeight) {
      return;
    }
    state.stage = "capturing";
    publish();
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas unavailable");
      }
      context.drawImage(video, 0, 0);
      // Freeze the chosen frame and release the device before encoding or review.
      stopCamera();
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.92);
      });
      canvas.width = canvas.height = 0;
      if (!isCurrent(value)) {
        return;
      }
      if (!blob) {
        throw new Error("Image encoding failed");
      }
      photo = new File(
        [blob],
        `camera-${Date.now()}.${blob.type === "image/png" ? "png" : "jpg"}`,
        { type: blob.type },
      );
      state.photoUrl = URL.createObjectURL(blob);
      state.stage = "review";
      publish();
    } catch {
      if (isCurrent(value)) {
        fail(t("chat.camera.captureFailed"));
      }
    }
  };
  const usePhoto = () => {
    if (!isCurrent(generation) || state.stage !== "review" || !photo) {
      return;
    }
    const file = photo;
    const destination = captureDestination;
    close();
    destination?.(file);
  };
  const openFileInput = (kind: "photo" | "camera") => {
    if (!isCurrent(generation) || (kind === "camera" && state.stage !== "error")) {
      return;
    }
    const destination = kind === "camera" ? nativeCaptureDestination : uploadDestination;
    close();
    destination?.(host);
  };
  createEffect(
    () => [props.disabled, props.readSignal] as const,
    ([disabled, readSignal]) => {
      if (state.stage !== "closed" && (disabled || readSignal !== activeSignal)) {
        close();
      }
    },
  );
  openCameras.set(host, show);
  window.addEventListener("pagehide", close);
  onCleanup(() => {
    active = false;
    releaseCamera();
    openCameras.delete(host);
    window.removeEventListener("pagehide", close);
  });
  const reviewing = () => view().stage === "review";
  const failed = () => view().stage === "error";
  const nativeFallback = () =>
    failed() && view().nativeFallback && Boolean(nativeCaptureDestination);
  return (
    <Show when={view().stage !== "closed"}>
      <openclaw-modal-dialog label={t("chat.camera.title")} onModal-cancel={close}>
        <section class="camera">
          <header>
            <div>
              <h2>{t("chat.camera.title")}</h2>
              <p>{reviewing() ? t("chat.camera.reviewHint") : t("chat.camera.previewHint")}</p>
            </div>
            <button
              type="button"
              class="icon-button"
              aria-label={t("common.close")}
              onClick={close}
            >
              <Icon name="x" />
            </button>
          </header>
          <div
            class="preview"
            aria-busy={
              view().stage === "requesting" || view().stage === "capturing" ? "true" : "false"
            }
          >
            <Show
              when={reviewing()}
              fallback={
                <video
                  autoplay
                  muted
                  playsinline
                  aria-label={t("chat.composer.cameraPreview")}
                  onLoadedData={(event) => {
                    const video = event.currentTarget;
                    if (video.srcObject === stream && isCurrent(generation)) {
                      state.videoReady = video.videoWidth > 0 && video.videoHeight > 0;
                      publish();
                    }
                  }}
                />
              }
            >
              <img src={view().photoUrl} alt={t("chat.camera.photoAlt")} />
            </Show>
            <Show
              when={failed()}
              fallback={
                <Show when={view().stage === "requesting" || view().stage === "capturing"}>
                  <div class="notice" role="status">
                    <Icon name="camera" />
                    <p>
                      {view().stage === "capturing"
                        ? t("chat.camera.capturing")
                        : t("chat.camera.requesting")}
                    </p>
                  </div>
                </Show>
              }
            >
              <div class="notice" role="alert">
                <Icon name="camera" />
                <strong>
                  {nativeFallback()
                    ? t("chat.camera.previewUnavailable")
                    : t("chat.camera.errorTitle")}
                </strong>
                <p>{view().error}</p>
              </div>
            </Show>
          </div>
          <Show when={!reviewing() && !failed() && view().cameras.length > 1}>
            <label class="camera-selector">
              {t("chat.composer.cameraInput")}
              <select
                value={view().cameraId}
                disabled={view().stage !== "live"}
                onChange={(event) => {
                  if (isCurrent(generation) && state.stage === "live") {
                    state.cameraId = event.currentTarget.value;
                    void startCamera();
                  }
                }}
              >
                <For each={view().cameras} keyed={(camera) => camera.deviceId}>
                  {(camera, index) => (
                    <option
                      value={camera().deviceId}
                      selected={camera().deviceId === view().cameraId}
                    >
                      {camera().label ||
                        t("chat.composer.cameraFallback", { number: String(index() + 1) })}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <footer>
            <button type="button" class="upload" onClick={() => openFileInput("photo")}>
              <Icon name="image" />
              {t("chat.camera.upload")}
            </button>
            <Show when={failed() && !nativeFallback() && Boolean(nativeCaptureDestination)}>
              <button type="button" class="upload" onClick={() => openFileInput("camera")}>
                <Icon name="camera" />
                {t("chat.camera.useNativeCamera")}
              </button>
            </Show>
            <div class="actions">
              <button
                type="button"
                autofocus
                onClick={() => (reviewing() ? void startCamera() : close())}
              >
                {reviewing() ? t("chat.camera.retake") : t("common.cancel")}
              </button>
              <button
                type="button"
                class="primary"
                disabled={
                  !reviewing() && !failed() && (view().stage !== "live" || !view().videoReady)
                }
                onClick={() =>
                  reviewing()
                    ? usePhoto()
                    : nativeFallback()
                      ? openFileInput("camera")
                      : failed()
                        ? void startCamera()
                        : void capture()
                }
              >
                {reviewing()
                  ? t("chat.camera.usePhoto")
                  : nativeFallback()
                    ? t("chat.camera.useNativeCamera")
                    : failed()
                      ? t("chat.camera.retry")
                      : t("chat.camera.capture")}
              </button>
            </div>
          </footer>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}

export const ChatCameraCapture = defineSolidBridge<CameraProps, { show(): void }>(
  "openclaw-chat-camera-capture",
  CameraCaptureContent,
  {
    properties: {
      disabled: { default: false },
      readSignal: { default: undefined, attribute: false },
      onCapture: { default: undefined, attribute: false },
      onUpload: { default: undefined, attribute: false },
      onNativeCapture: { default: undefined, attribute: false },
    },
    methods: { show: (host) => openCameras.get(host)?.() },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-camera-capture": OpenClawChatCameraCapture;
  }
}
