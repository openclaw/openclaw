import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/modal-dialog.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCameraEnglish } from "../../../i18n/locales/en-chat-camera.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";
import { cameraCaptureStyles } from "./chat-camera-capture.styles.ts";

registerChatCameraEnglish();

type CameraStage = "closed" | "requesting" | "live" | "capturing" | "review" | "error";

/** One composer owns the camera, its pending permission request, and the chosen still. */
export class OpenClawChatCameraCapture extends OpenClawLitElement {
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) readSignal?: AbortSignal;
  @property({ attribute: false }) onCapture?: (file: File) => void;
  @property({ attribute: false }) onUpload?: (source: HTMLElement) => void;
  @property({ attribute: false }) onNativeCapture?: (source: HTMLElement) => void;
  @state() private nativeFallback = false;
  @state() private stage: CameraStage = "closed";
  @state() private error = "";
  @state() private photoUrl = "";
  @state() private cameras: MediaDeviceInfo[] = [];
  @state() private cameraId = "";
  @state() private videoReady = false;
  private generation = 0;
  private stream?: MediaStream;
  private photo?: File;
  private activeSignal?: AbortSignal;
  private captureDestination?: (file: File) => void;
  private uploadDestination?: (source: HTMLElement) => void;
  private nativeCaptureDestination?: (source: HTMLElement) => void;

  static override styles = cameraCaptureStyles;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pagehide", this.close);
  }

  override disconnectedCallback() {
    this.close();
    window.removeEventListener("pagehide", this.close);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      this.stage !== "closed" &&
      ((changed.has("disabled") && this.disabled) ||
        (changed.has("readSignal") && this.readSignal !== this.activeSignal))
    ) {
      this.close();
    }
  }

  show(): void {
    if (!this.isConnected || this.disabled || this.readSignal?.aborted || this.stage !== "closed") {
      return;
    }
    this.activeSignal = this.readSignal;
    this.activeSignal?.addEventListener("abort", this.close, { once: true });
    this.captureDestination = this.onCapture;
    this.uploadDestination = this.onUpload;
    this.nativeCaptureDestination = this.onNativeCapture;
    this.cameraId = "";
    this.cameras = [];
    this.stage = "requesting";
    // Keep getUserMedia in the menu's user gesture, before awaiting Lit rendering.
    void this.startCamera();
  }

  private isCurrent(generation: number): boolean {
    return (
      generation === this.generation &&
      this.stage !== "closed" &&
      this.isConnected &&
      !this.disabled &&
      this.activeSignal === this.readSignal &&
      !this.activeSignal?.aborted
    );
  }

  private stopCamera() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    const video = this.renderRoot.querySelector("video");
    if (video) {
      video.srcObject = null;
    }
    this.videoReady = false;
  }

  private clearPhoto() {
    if (this.photoUrl) {
      URL.revokeObjectURL(this.photoUrl);
    }
    this.photoUrl = "";
    this.photo = undefined;
  }

  private close = () => {
    this.generation += 1;
    this.stopCamera();
    this.clearPhoto();
    this.activeSignal?.removeEventListener("abort", this.close);
    this.activeSignal = undefined;
    this.captureDestination = undefined;
    this.uploadDestination = undefined;
    this.nativeCaptureDestination = undefined;
    this.stage = "closed";
  };

  private fail(message: string, nativeFallback = false) {
    this.generation += 1;
    this.stopCamera();
    this.error = message;
    this.nativeFallback = nativeFallback;
    this.stage = "error";
  }

  private async startCamera() {
    if (!this.isCurrent(this.generation)) {
      return;
    }
    const generation = ++this.generation;
    this.stopCamera();
    this.clearPhoto();
    this.stage = "requesting";
    this.error = "";
    this.nativeFallback = false;
    if (!globalThis.isSecureContext) {
      this.fail(t("chat.camera.insecure"), true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail(t("chat.camera.unsupported"), true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: this.cameraId
          ? { deviceId: { exact: this.cameraId } }
          : { facingMode: { ideal: "environment" } },
      });
      // Permission prompts cannot be canceled. A late grant still belongs to the old draft.
      if (!this.isCurrent(generation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") {
        this.fail(t("chat.camera.stopped"));
        return;
      }
      track.addEventListener(
        "ended",
        () => {
          if (this.isCurrent(generation) && this.stream === stream) {
            this.fail(t("chat.camera.stopped"));
          }
        },
        { once: true },
      );
      this.cameraId = track.getSettings().deviceId ?? this.cameraId;
      void this.listCameras(generation);
      await this.updateComplete;
      if (!this.isCurrent(generation)) {
        return;
      }
      const video = this.renderRoot.querySelector("video");
      if (!video) {
        return;
      }
      video.srcObject = stream;
      await video.play();
      if (!this.isCurrent(generation)) {
        return;
      }
      this.videoReady = video.videoWidth > 0 && video.videoHeight > 0;
      this.stage = "live";
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      const name = error instanceof DOMException || error instanceof Error ? error.name : "";
      this.fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? t("chat.camera.permissionDenied")
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? t("chat.camera.notFound")
            : t("chat.camera.unavailable"),
      );
    }
  }

  private async listCameras(generation: number) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (this.isCurrent(generation)) {
        this.cameras = devices.filter((device) => device.kind === "videoinput");
      }
    } catch {
      // Device enumeration is optional; a usable preview must not depend on it.
    }
  }

  private capture = async () => {
    const video = this.renderRoot.querySelector("video");
    const generation = this.generation;
    if (
      !this.isCurrent(generation) ||
      this.stage !== "live" ||
      !video?.videoWidth ||
      !video.videoHeight
    ) {
      return;
    }
    this.stage = "capturing";
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
      this.stopCamera();
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.92);
      });
      canvas.width = canvas.height = 0;
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!blob) {
        throw new Error("Image encoding failed");
      }
      this.photo = new File(
        [blob],
        `camera-${Date.now()}.${blob.type === "image/png" ? "png" : "jpg"}`,
        { type: blob.type },
      );
      this.photoUrl = URL.createObjectURL(blob);
      this.stage = "review";
    } catch {
      if (this.isCurrent(generation)) {
        this.fail(t("chat.camera.captureFailed"));
      }
    }
  };

  private usePhoto = () => {
    if (!this.isCurrent(this.generation) || this.stage !== "review" || !this.photo) {
      return;
    }
    const photo = this.photo;
    const destination = this.captureDestination;
    this.close();
    destination?.(photo);
  };

  private upload = () => {
    if (!this.isCurrent(this.generation)) {
      return;
    }
    const destination = this.uploadDestination;
    this.close();
    destination?.(this);
  };

  private useNativeCamera = () => {
    if (!this.isCurrent(this.generation) || this.stage !== "error" || !this.nativeFallback) {
      return;
    }
    const destination = this.nativeCaptureDestination;
    this.close();
    destination?.(this);
  };

  override render() {
    if (this.stage === "closed") {
      return nothing;
    }
    const reviewing = this.stage === "review";
    const failed = this.stage === "error";
    const nativeFallback = failed && this.nativeFallback && Boolean(this.nativeCaptureDestination);
    return html`
      <openclaw-modal-dialog .label=${t("chat.camera.title")} @modal-cancel=${this.close}>
        <section class="camera">
          <header>
            <div>
              <h2>${t("chat.camera.title")}</h2>
              <p>${reviewing ? t("chat.camera.reviewHint") : t("chat.camera.previewHint")}</p>
            </div>
            <button
              type="button"
              class="icon-button"
              aria-label=${t("common.close")}
              @click=${this.close}
            >
              ${icons.x}
            </button>
          </header>
          <div
            class="preview"
            aria-busy=${this.stage === "requesting" || this.stage === "capturing" ? "true" : "false"}
          >
            ${
              reviewing
                ? html`<img src=${this.photoUrl} alt=${t("chat.camera.photoAlt")} />`
                : html`<video
                    autoplay
                    muted
                    playsinline
                    aria-label=${t("chat.composer.cameraPreview")}
                    @loadeddata=${(event: Event) => {
                      const video = event.currentTarget;
                      if (
                        video instanceof HTMLVideoElement &&
                        video.srcObject === this.stream &&
                        this.isCurrent(this.generation)
                      ) {
                        this.videoReady = video.videoWidth > 0 && video.videoHeight > 0;
                      }
                    }}
                  ></video>`
            }
            ${
              failed
                ? html`<div class="notice" role="alert">
                    ${icons.camera}<strong
                      >${nativeFallback ? t("chat.camera.previewUnavailable") : t("chat.camera.errorTitle")}</strong
                    >
                    <p>${this.error}</p>
                  </div>`
                : this.stage === "requesting" || this.stage === "capturing"
                  ? html`<div class="notice" role="status">
                      ${icons.camera}
                      <p>
                        ${this.stage === "capturing" ? t("chat.camera.capturing") : t("chat.camera.requesting")}
                      </p>
                    </div>`
                  : nothing
            }
          </div>
          ${
            !reviewing && !failed && this.cameras.length > 1
              ? html`<label class="camera-selector"
                  >${t("chat.composer.cameraInput")}
                  <select
                    .value=${this.cameraId}
                    ?disabled=${this.stage !== "live"}
                    @change=${(event: Event) => {
                      const select = event.currentTarget;
                      if (
                        select instanceof HTMLSelectElement &&
                        this.isCurrent(this.generation) &&
                        this.stage === "live"
                      ) {
                        this.cameraId = select.value;
                        void this.startCamera();
                      }
                    }}
                  >
                    ${this.cameras.map((camera, index) => html`<option value=${camera.deviceId} ?selected=${camera.deviceId === this.cameraId}>${camera.label || t("chat.composer.cameraFallback", { number: String(index + 1) })}</option>`)}
                  </select>
                </label>`
              : nothing
          }
          <footer>
            <button type="button" class="upload" @click=${this.upload}>
              ${icons.image}${t("chat.camera.upload")}
            </button>
            <div class="actions">
              <button
                type="button"
                autofocus
                @click=${reviewing ? () => void this.startCamera() : this.close}
              >
                ${reviewing ? t("chat.camera.retake") : t("common.cancel")}
              </button>
              <button
                type="button"
                class="primary"
                ?disabled=${!reviewing && !failed && (this.stage !== "live" || !this.videoReady)}
                @click=${reviewing ? this.usePhoto : nativeFallback ? this.useNativeCamera : failed ? () => void this.startCamera() : this.capture}
              >
                ${reviewing ? t("chat.camera.usePhoto") : nativeFallback ? t("chat.camera.useNativeCamera") : failed ? t("chat.camera.retry") : t("chat.camera.capture")}
              </button>
            </div>
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-chat-camera-capture")) {
  customElements.define("openclaw-chat-camera-capture", OpenClawChatCameraCapture);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-camera-capture": OpenClawChatCameraCapture;
  }
}
