import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { generateUUID } from "../../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { readLinkFavicon } from "../link-favicon-cache.ts";
import type { LinkFaviconFetcher } from "../link-favicon-loader.ts";

registerChatMessageMetadataEnglish();

function bindSourcePopover(element: Element | undefined) {
  const trigger = element?.previousElementSibling;
  if (element instanceof WaPopover && trigger instanceof HTMLButtonElement) {
    trigger.id ||= `chat-source-${generateUUID()}`;
    element.id ||= `${trigger.id}-preview`;
    element.for = trigger.id;
    trigger.setAttribute("aria-controls", element.id);
  }
}

function syncSourceExpanded(event: Event) {
  const popover = event.currentTarget;
  if (popover instanceof WaPopover) {
    popover.anchor?.setAttribute("aria-expanded", String(popover.open));
  }
}

function closeSourcePreview(event: Event) {
  const target = event.currentTarget;
  const popover = target instanceof Element ? target.closest("wa-popover") : null;
  if (popover instanceof WaPopover) {
    popover.open = false;
    if (popover.anchor instanceof HTMLElement) {
      popover.anchor.focus({ preventScroll: true });
    }
  }
}

class ChatSourcePreviews extends OpenClawLightDomElement {
  static override properties = {
    sources: { attribute: false },
    fetchFavicon: { attribute: false },
  };
  sources: readonly ChatSourcePreview[] = [];
  fetchFavicon?: LinkFaviconFetcher;
  private readonly failedFavicons = new Set<string>();
  private readonly refreshFavicons = () => {
    if (this.isConnected) {
      this.requestUpdate();
    }
  };

  private renderFavicon(source: ChatSourcePreview) {
    const url = this.fetchFavicon
      ? readLinkFavicon(new URL(source.url).hostname, this.fetchFavicon, this.refreshFavicons)
      : null;
    return url && !this.failedFavicons.has(url)
      ? html`<img
          src=${url}
          alt=""
          @error=${() => {
            this.failedFavicons.add(url);
            this.requestUpdate();
          }}
        />`
      : icons.globe;
  }

  override disconnectedCallback() {
    // Retire the library's open-popover registration when a transcript row leaves.
    for (const popover of this.querySelectorAll<WaPopover>("wa-popover")) {
      popover.open = false;
    }
    super.disconnectedCallback();
  }

  override willUpdate() {
    const retained = new Set(this.sources.map((source) => source.url));
    for (const popover of this.querySelectorAll<WaPopover>("wa-popover")) {
      if (!retained.has(popover.dataset.sourceUrl ?? "")) {
        popover.open = false;
      }
    }
  }

  override render() {
    return html`<div
      class="chat-source-strip"
      role="group"
      aria-label=${t("chat.messages.sourcePreviews.label")}
    >
      <div class="chat-source-strip__label">${t("chat.messages.sourcePreviews.label")}</div>
      <div class="chat-source-strip__cards">
        ${repeat(
          this.sources,
          (source) => source.url,
          (source) => html`
            <div class="chat-source-strip__item">
              <button
                class="chat-source-card"
                type="button"
                aria-haspopup="dialog"
                aria-expanded="false"
              >
                <span class="chat-source-card__title">${source.title}</span>
                <span class="chat-source-card__domain"
                  ><span class="chat-source-card__icon" aria-hidden="true"
                    >${this.renderFavicon(source)}</span
                  >${source.domain}</span
                >
              </button>
              <wa-popover
                ${ref(bindSourcePopover)}
                class="chat-source-popover"
                data-source-url=${source.url}
                placement="bottom-start"
                without-arrow
                @wa-show=${syncSourceExpanded}
                @wa-hide=${syncSourceExpanded}
              >
                <section aria-label=${source.title}>
                  <div class="chat-source-popover__header">
                    <span class="chat-source-card__domain">${source.domain}</span>
                    <button
                      class="chat-source-popover__close"
                      type="button"
                      aria-label=${t("common.close")}
                      @click=${closeSourcePreview}
                    >
                      ${icons.x}
                    </button>
                  </div>
                  ${
                    source.excerpt
                      ? html`
                          <div class="chat-source-popover__kind">
                            ${t(source.excerptKind === "page" ? "chat.messages.sourcePreviews.pageExcerpt" : "chat.messages.sourcePreviews.searchSnippet")}
                          </div>
                          <p class="chat-source-popover__excerpt">${source.excerpt}</p>
                        `
                      : html`<p class="chat-source-popover__unavailable">
                          ${t("chat.messages.sourcePreviews.unavailable")}
                        </p>`
                  }
                  <a
                    class="chat-source-popover__open"
                    href=${source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    >${t("chat.messages.sourcePreviews.open")}<span aria-hidden="true"
                      >${icons.externalLink}</span
                    ></a
                  >
                </section>
              </wa-popover>
            </div>
          `,
        )}
      </div>
    </div>`;
  }
}

if (!customElements.get("openclaw-chat-sources")) {
  customElements.define("openclaw-chat-sources", ChatSourcePreviews);
}

export function renderChatSourcePreviews(
  sources: readonly ChatSourcePreview[],
  fetchFavicon?: LinkFaviconFetcher,
) {
  return sources.length > 0
    ? html`<openclaw-chat-sources
        .sources=${sources}
        .fetchFavicon=${fetchFavicon}
      ></openclaw-chat-sources>`
    : nothing;
}
