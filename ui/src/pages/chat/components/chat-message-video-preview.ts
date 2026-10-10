import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { requestVideoPoster } from "../../../lib/media/video-poster.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";

type VideoPreview = {
  key: string;
  src: string;
  label: string;
  onOpen: () => void;
  fallback: TemplateResult;
};

class MessageVideoPreviewDirective extends AsyncDirective {
  private input: VideoPreview | undefined;
  private controller: AbortController | undefined;
  private posterUrl: string | undefined;
  private failed = false;
  private visible = false;
  private element: Element | undefined;
  private stopObserving: (() => void) | undefined;

  override render(input: VideoPreview) {
    if (this.input?.key !== input.key) {
      this.release();
      this.failed = false;
    }
    this.input = input;
    this.requestPoster();
    return this.template();
  }

  private requestPoster() {
    if (!this.isConnected || !this.visible || !this.input || this.controller || this.failed) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    void requestVideoPoster({
      key: this.input.key,
      src: this.input.src,
      width: 400,
      height: 225,
      signal: controller.signal,
    }).then((blob) => {
      if (
        this.controller !== controller ||
        controller.signal.aborted ||
        !this.isConnected ||
        !this.visible
      ) {
        return;
      }
      if (blob) {
        this.posterUrl = URL.createObjectURL(blob);
      } else {
        this.failed = true;
      }
      this.setValue(this.template());
    });
  }

  private release() {
    this.controller?.abort();
    this.controller = undefined;
    if (this.posterUrl) {
      URL.revokeObjectURL(this.posterUrl);
      this.posterUrl = undefined;
    }
  }

  private failPoster(source: string) {
    if (!this.isConnected || this.posterUrl !== source) {
      return;
    }
    this.release();
    this.failed = true;
    this.setValue(this.template());
  }

  private setVisible(visible: boolean) {
    if (!this.isConnected || this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (visible) {
      this.requestPoster();
    } else {
      this.release();
      this.setValue(this.template());
    }
  }

  private observe() {
    this.stopObserving?.();
    this.stopObserving =
      this.element && this.isConnected
        ? observeChatAttachmentViewport(
            this.element,
            () => this.setVisible(true),
            () => this.setVisible(false),
          )
        : undefined;
  }

  private readonly setElement = (element: Element | undefined) => {
    this.element = element;
    this.observe();
  };

  protected override disconnected() {
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.visible = false;
    this.release();
  }

  protected override reconnected() {
    this.setValue(this.template());
    this.observe();
  }

  private template() {
    const input = this.input;
    if (!input) {
      return nothing;
    }
    const posterUrl = this.posterUrl;
    return html`<div class="chat-video-preview__content" ${ref(this.setElement)}>
      ${
        this.failed
          ? input.fallback
          : html`<button
              type="button"
              class="chat-message-image-button"
              aria-label=${`${t("chat.attachments.open")}: ${input.label}`}
              @click=${input.onOpen}
            >
              ${posterUrl ? html`<img class="chat-message-image" src=${posterUrl} alt=${input.label} @error=${() => this.failPoster(posterUrl)} />` : html`<span class="chat-message-image chat-video-preview__placeholder"></span>`}
              <span class="chat-video-preview__play" aria-hidden="true">${icons.play}</span>
            </button>`
      }
    </div>`;
  }
}

export const renderMessageVideoPreview = directive(MessageVideoPreviewDirective);
