import { createStore, For, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/modal-dialog.ts";
import { registerChatCameraEnglish } from "../../../i18n/locales/en-chat-camera.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
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
const openCameras = new WeakMap<OpenClawChatCameraCapture, { show(): void; syncInputs(): void }>();

/** One composer owns the camera, its pending permission request, and the chosen still. */
function CameraCaptureContent(_props: CameraProps, host: OpenClawChatCameraCapture) {
  const [state, setState] = createStore<{
    nativeFallback: boolean;
    stage: CameraStage;
    error: string;
    photoUrl: string;
    cameras: MediaDeviceInfo[];
    cameraId: string;
    videoReady: boolean;
  }>({
    nativeFallback: false,
    stage: "closed",
    error: "",
    photoUrl: "",
    cameras: [],
    cameraId: "",
    videoReady: false,
  });
  let generation = 0;
  let stream: MediaStream | undefined;
  let photo: File | undefined;
  let releasePhoto: (() => void) | undefined;
  // This synchronous scope retires permission/encoding work before Solid commits the view.
  let scope: { signal?: AbortSignal; release: () => void } | undefined;
  let video: HTMLVideoElement | undefined;
  let cancelButton!: HTMLButtonElement;
  let releaseTrack: (() => void) | undefined;
  let captureDestination: CameraProps["onCapture"];
  let uploadDestination: CameraProps["onUpload"];
  let nativeCaptureDestination: CameraProps["onNativeCapture"];
  const isCurrent = (value: number) =>
    value === generation &&
    scope !== undefined &&
    host.isConnected &&
    !host.disabled &&
    scope.signal === host.readSignal &&
    !scope.signal?.aborted;
  const stopCamera = () => {
    releaseTrack?.();
    releaseTrack = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (video) {
      video.srcObject = null;
    }
  };
  const clearPhoto = () => {
    releasePhoto?.();
    releasePhoto = undefined;
    photo = undefined;
  };
  const releaseCamera = () => {
    generation += 1;
    stopCamera();
    clearPhoto();
    scope?.release();
    scope = undefined;
    captureDestination = uploadDestination = nativeCaptureDestination = undefined;
  };
  const close = () => {
    releaseCamera();
    setState((draft) => {
      draft.stage = "closed";
      draft.photoUrl = "";
      draft.videoReady = false;
    });
  };
  const fail = (message: string, nativeFallback = false) => {
    generation += 1;
    stopCamera();
    setState((draft) => {
      draft.videoReady = false;
      draft.error = message;
      draft.nativeFallback = nativeFallback;
      draft.stage = "error";
    });
  };
  const listCameras = async (value: number) => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (isCurrent(value)) {
        setState((draft) => {
          draft.cameras = devices.filter((device) => device.kind === "videoinput");
        });
      }
    } catch {
      // Device enumeration is optional; a usable preview must not depend on it.
    }
  };
  const startCamera = async (cameraId = state.cameraId) => {
    if (!isCurrent(generation)) {
      return;
    }
    const value = ++generation;
    stopCamera();
    clearPhoto();
    setState((draft) => {
      draft.photoUrl = "";
      draft.videoReady = false;
      draft.stage = "requesting";
      draft.cameraId = cameraId;
      draft.error = "";
      draft.nativeFallback = false;
    });
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
        video: cameraId
          ? { deviceId: { exact: cameraId } }
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
      releaseTrack = listen(
        track,
        "ended",
        () => {
          if (isCurrent(value) && stream === nextStream) {
            fail(t("chat.camera.stopped"));
          }
        },
        { once: true },
      );
      setState((draft) => {
        draft.cameraId = track.getSettings().deviceId ?? draft.cameraId;
      });
      void listCameras(value);
      await host.updateComplete;
      if (!isCurrent(value)) {
        return;
      }
      const preview = video;
      if (!preview) {
        return;
      }
      preview.srcObject = stream;
      await preview.play();
      if (!isCurrent(value)) {
        return;
      }
      setState((draft) => {
        draft.videoReady = preview.videoWidth > 0 && preview.videoHeight > 0;
        draft.stage = "live";
      });
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
    if (!host.isConnected || host.disabled || host.readSignal?.aborted || scope !== undefined) {
      return;
    }
    if (host.onNativeCapture && useNativeAttachmentCapture()) {
      host.onNativeCapture(host);
      return;
    }
    const signal = host.readSignal;
    scope = { signal, release: signal ? listen(signal, "abort", close, { once: true }) : () => {} };
    captureDestination = host.onCapture;
    uploadDestination = host.onUpload;
    nativeCaptureDestination = host.onNativeCapture;
    setState((draft) => {
      draft.cameras = [];
    });
    // Keep getUserMedia in the menu's user gesture, before the first rendered frame.
    void startCamera("");
  };
  const capture = async () => {
    const value = generation;
    if (!isCurrent(value) || state.stage !== "live" || !video?.videoWidth || !video.videoHeight) {
      return;
    }
    setState((draft) => {
      draft.stage = "capturing";
      draft.videoReady = false;
    });
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
      const photoUrl = URL.createObjectURL(blob);
      releasePhoto = () => URL.revokeObjectURL(photoUrl);
      setState((draft) => {
        draft.photoUrl = photoUrl;
        draft.stage = "review";
      });
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
  onSettled(() => {
    openCameras.set(host, {
      show,
      syncInputs: () => {
        if (scope && (host.disabled || host.readSignal !== scope.signal)) {
          close();
        }
      },
    });
    const releasePage = listen(window, "pagehide", close);
    return () => {
      releaseCamera();
      openCameras.delete(host);
      releasePage();
    };
  });
  const reviewing = () => state.stage === "review";
  const failed = () => state.stage === "error";
  const nativeFallback = () =>
    failed() && state.nativeFallback && Boolean(nativeCaptureDestination);
  return (
    <Show when={state.stage !== "closed"}>
      <openclaw-modal-dialog
        prop:initialFocus={() => cancelButton}
        label={t("chat.camera.title")}
        onModal-cancel={close}
      >
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
              state.stage === "requesting" || state.stage === "capturing" ? "true" : "false"
            }
          >
            <Show
              when={reviewing()}
              fallback={
                <video
                  ref={(element) => {
                    video = element;
                  }}
                  autoplay
                  muted
                  playsinline
                  aria-label={t("chat.composer.cameraPreview")}
                  onLoadedData={(event) => {
                    const preview = event.currentTarget;
                    if (preview.srcObject === stream && isCurrent(generation)) {
                      setState((draft) => {
                        draft.videoReady = preview.videoWidth > 0 && preview.videoHeight > 0;
                      });
                    }
                  }}
                />
              }
            >
              <img src={state.photoUrl} alt={t("chat.camera.photoAlt")} />
            </Show>
            <Show
              when={failed()}
              fallback={
                <Show when={state.stage === "requesting" || state.stage === "capturing"}>
                  <div class="notice" role="status">
                    <Icon name="camera" />
                    <p>
                      {state.stage === "capturing"
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
                <p>{state.error}</p>
              </div>
            </Show>
          </div>
          <Show when={!reviewing() && !failed() && state.cameras.length > 1}>
            <label class="camera-selector">
              {t("chat.composer.cameraInput")}
              <select
                value={state.cameraId}
                disabled={state.stage !== "live"}
                onChange={(event) => {
                  if (isCurrent(generation) && state.stage === "live") {
                    const cameraId = event.currentTarget.value;
                    void startCamera(cameraId);
                  }
                }}
              >
                <For each={state.cameras} keyed={(camera) => camera.deviceId}>
                  {(camera, index) => (
                    <option
                      value={camera().deviceId}
                      selected={camera().deviceId === state.cameraId}
                    >
                      {camera().label ||
                        t("chat.composer.cameraFallback", { number: String(index() + 1) })}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <openclaw-modal-actions class="camera__actions">
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

            <button
              type="button"
              autofocus
              ref={(element) => {
                cancelButton = element;
              }}
              onClick={() => (reviewing() ? void startCamera() : close())}
            >
              {reviewing() ? t("chat.camera.retake") : t("common.cancel")}
            </button>
            <button
              type="button"
              class="primary"
              disabled={!reviewing() && !failed() && (state.stage !== "live" || !state.videoReady)}
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
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}

export const ChatCameraCapture = defineSolidBridge<CameraProps, { show(): void }>(
  "openclaw-chat-camera-capture",
  CameraCaptureContent,
  {
    propertyChanged: (host, key) => {
      if (key === "disabled" || key === "readSignal") {
        // Native inputs can arrive during a parent render; retire the scope after that commit.
        queueMicrotask(() => openCameras.get(host)?.syncInputs());
      }
    },
    properties: {
      disabled: { default: false },
      readSignal: { default: undefined, attribute: false },
      onCapture: { default: undefined, attribute: false },
      onUpload: { default: undefined, attribute: false },
      onNativeCapture: { default: undefined, attribute: false },
    },
    methods: { show: (host) => openCameras.get(host)?.show() },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-camera-capture": OpenClawChatCameraCapture;
  }
}
