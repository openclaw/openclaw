import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import {
  openAttachmentCardFromClick,
  renderAttachmentCardHeader,
  renderCompactAttachmentCard,
} from "./chat-attachment-card.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";

class ChatVideoPlayer extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property({ type: Boolean }) preview = false;
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property() playback: ChatMediaPlaybackMode = "native";
  @property() authToken: string | null = null;
  @property({ type: Number }) sizeBytes: number | undefined;
  @property({ type: Number }) mediaWidth: number | undefined;
  @property({ type: Number }) mediaHeight: number | undefined;
  @property({ attribute: false }) onExpand: ((src: string) => void) | undefined;
  @property({ attribute: false }) onFallbackExpand: (() => void) | undefined;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  // Buffering can lower readyState after the first frame without another loadeddata event.
  @state() private frameReady = false;

  private media: HTMLVideoElement | null = null;
  private mediaVisible = false;
  private viewportElement: HTMLElement | null = null;
  private stopObservingViewport: (() => void) | undefined;
  private readonly sourceController = new ChatMediaSourceController();

  override connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.syncSource());
  }

  override disconnectedCallback(): void {
    this.stopObservingViewport?.();
    this.stopObservingViewport = undefined;
    this.viewportElement = null;
    this.sourceController.cancel();
    if (this.media) {
      this.sourceController.reset(this.media);
    }
    super.disconnectedCallback();
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("src") && !this.src && this.media) {
      this.sourceController.cancel();
      this.sourceController.reset(this.media);
    }
    if (
      this.sourceController.readiness === "unavailable" &&
      (changedProperties.has("src") ||
        changedProperties.has("sourceIdentity") ||
        changedProperties.has("playback") ||
        changedProperties.has("authToken"))
    ) {
      this.sourceController.cancel();
    }
  }

  override updated(changedProperties: PropertyValues<this>): void {
    if (
      changedProperties.has("src") ||
      changedProperties.has("sourceIdentity") ||
      changedProperties.has("playback") ||
      changedProperties.has("authToken")
    ) {
      this.syncSource();
    }
  }

  private setMedia = (element: Element | undefined) => {
    this.frameReady = false;
    this.media = element instanceof HTMLVideoElement ? element : null;
    this.syncSource();
  };

  private setViewportElement = (element: Element | undefined) => {
    const viewportElement = element instanceof HTMLElement ? element : null;
    if (this.viewportElement === viewportElement) {
      return;
    }
    this.stopObservingViewport?.();
    this.stopObservingViewport = undefined;
    this.viewportElement = viewportElement;
    if (!viewportElement) {
      return;
    }
    this.stopObservingViewport = observeChatAttachmentViewport(viewportElement, () => {
      this.mediaVisible = true;
      this.syncSource();
    });
  };

  private syncSource(): void {
    const media = this.media;
    if (!media || !this.isConnected || !this.mediaVisible) {
      return;
    }
    const pending = this.sourceController.sync(
      media,
      this.src,
      this.sourceIdentity,
      this.playback,
      this.authToken,
    );
    this.requestUpdate();
    void pending?.then(() => {
      if (this.isConnected) {
        this.requestUpdate();
      }
    });
  }

  private adoptPendingSource(): boolean {
    if (!this.media || !this.sourceController.applyPendingSource(this.media)) {
      return false;
    }
    this.requestUpdate();
    return true;
  }

  private expand = () => {
    const source = this.sourceController.readySource;
    if (!source) {
      return;
    }
    this.media?.pause();
    this.onExpand?.(source);
  };

  override render() {
    const downloadHref = safeMediaAttachmentHref(this.src);
    const preparing = this.sourceController.readiness === "preparing" && !this.preview;
    if (this.sourceController.readiness === "unavailable") {
      return renderCompactAttachmentCard({
        kind: "video",
        label: this.label,
        mimeType: this.mimeType,
        sizeBytes: this.sizeBytes,
        downloadHref,
        onExpand: this.onFallbackExpand,
      });
    }
    const loading = this.preview && !this.frameReady;
    const onExpand = this.onExpand && this.sourceController.readySource ? this.expand : undefined;
    const dimensions =
      this.mediaWidth && this.mediaHeight
        ? { "aspect-ratio": `${this.mediaWidth} / ${this.mediaHeight}` }
        : this.preview
          ? { "aspect-ratio": "16 / 9" }
          : {};
    return html`
      <div
        class="chat-assistant-attachment-card chat-assistant-attachment-card--video"
        aria-busy=${loading ? "true" : nothing}
        ${ref(this.setViewportElement)}
        ?data-openable=${Boolean(onExpand)}
        @click=${(event: MouseEvent) => openAttachmentCardFromClick(event, onExpand)}
      >
        ${renderAttachmentCardHeader({
          kind: "video",
          label: this.label,
          mimeType: this.mimeType,
          sizeBytes: this.sizeBytes,
          downloadHref,
          downloadPending: this.preview && !downloadHref,
          loading,
          expandLabel: t("chat.mediaPlayer.openVideo", { filename: this.label }),
          onExpand,
          visualMode: "preview-with-favicon",
        })}
        ${
          preparing
            ? html`<div class="chat-assistant-attachment-card__reason chat-media-preparing">
                ${t("chat.mediaPlayer.preparing")}
              </div>`
            : null
        }
        <div class="chat-assistant-video-frame" ?hidden=${preparing}>
          ${
            loading
              ? html`<div
                  class="chat-video-skeleton"
                  role="status"
                  aria-label=${t("common.loading")}
                >
                  <div class="chat-video-skeleton__controls" aria-hidden="true">
                    ${icons.play}<span>0:00<span>/ 0:00</span></span>
                    ${icons.volume2}${icons.maximize}${icons.moreHorizontal}
                  </div>
                  <div class="chat-video-skeleton__timeline skeleton" aria-hidden="true"></div>
                </div>`
              : nothing
          }
          <video
            controls
            preload=${this.preview ? "auto" : "metadata"}
            style=${styleMap(dimensions)}
            ${ref(this.setMedia)}
            @loadeddata=${() => {
              this.frameReady = true;
            }}
            @playing=${() => {
              this.frameReady = true;
            }}
            @emptied=${() => {
              this.frameReady = false;
            }}
            @loadedmetadata=${() => {
              if (!this.media) {
                return;
              }
              this.sourceController.handleLoadedMetadata(this.media);
              this.onMediaLoaded?.();
            }}
            @ended=${() => {
              if (this.media && this.sourceController.handleEnded(this.media)) {
                this.requestUpdate();
              }
            }}
            @play=${() => this.adoptPendingSource()}
            @seeking=${() => {
              if (
                !this.adoptPendingSource() &&
                this.media?.error &&
                this.sourceController.handleError(this.media)
              ) {
                this.requestUpdate();
              }
            }}
            @error=${() => {
              if (this.media) {
                this.sourceController.handleError(this.media);
                this.requestUpdate();
              }
            }}
          ></video>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-video-player")) {
  customElements.define("openclaw-chat-video-player", ChatVideoPlayer);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-video-player": ChatVideoPlayer;
  }
}
