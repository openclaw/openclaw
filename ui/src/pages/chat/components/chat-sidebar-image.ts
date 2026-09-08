import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import { t } from "../../../i18n/index.ts";
import { renderAttachmentPreviewSkeleton } from "./chat-attachment-card.ts";

class SidebarImageDirective extends AsyncDirective {
  private src = "";
  private label = "";
  private status: "pending" | "ready" | "error" = "pending";
  private image: HTMLImageElement | undefined;

  private setImage = (element: Element | undefined) => {
    this.image = element instanceof HTMLImageElement ? element : undefined;
    if (this.image?.complete) {
      const image = this.image;
      // Ref reconnects after a retained image may have finished while detached.
      queueMicrotask(() => this.settleImage(image, image.naturalWidth > 0));
    }
  };

  private settleImage(image: EventTarget | null, loaded: boolean) {
    if (
      this.isConnected &&
      this.image?.isConnected &&
      image === this.image &&
      this.image.getAttribute("src") === this.src
    ) {
      this.status = loaded ? "ready" : "error";
      this.setValue(this.render(this.src, this.label));
    }
  }

  override render(src: string, label: string) {
    if (src !== this.src) {
      this.src = src;
      this.status = "pending";
    }
    this.label = label;
    return html`<div
      class="sidebar-attachment-preview__image-slot"
      aria-busy=${this.status === "pending" ? "true" : nothing}
    >
      ${
        this.status === "pending"
          ? renderAttachmentPreviewSkeleton(true)
          : this.status === "error"
            ? html`<div class="sidebar-attachment-preview__unavailable">
                ${t("chat.attachments.previewUnavailable")}
              </div>`
            : nothing
      }
      ${
        src
          ? keyed(
              src,
              html`<img
                class="sidebar-attachment-preview__image"
                src=${src}
                alt=${label}
                style=${styleMap({ display: this.status === "ready" ? undefined : "none" })}
                ${ref(this.setImage)}
                @load=${(event: Event) => this.settleImage(event.currentTarget, true)}
                @error=${(event: Event) => this.settleImage(event.currentTarget, false)}
              />`,
            )
          : nothing
      }
    </div>`;
  }
}

export const renderSidebarImage = directive(SidebarImageDirective);
