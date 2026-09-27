import { html, nothing, render } from "lit";
import type { ControlUiLinkPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import "../styles/link-hovercard.css";

/** Presentation only; the shared hover owner controls lifetime, focus and requests. */
export function renderPagePreview(
  card: HTMLDivElement,
  href: string,
  fallbackTitle: string,
  preview: ControlUiLinkPreview,
  failedImages: ReadonlySet<string>,
  failed: (src: string) => void,
  position: () => void,
): void {
  const host = new URL(href).host;
  const title = preview.title || fallbackTitle || host;
  const image =
    preview.imageDataUrl && !failedImages.has(preview.imageDataUrl)
      ? preview.imageDataUrl
      : undefined;
  const favicon =
    preview.faviconDataUrl && !failedImages.has(preview.faviconDataUrl)
      ? preview.faviconDataUrl
      : undefined;
  card.setAttribute("aria-label", title);
  render(
    html`<header class="link-hovercard__header">
        <span class="link-hovercard__identity"
          >${favicon ? html`<img src=${favicon} alt="" @error=${() => failed(favicon)} @load=${position} />` : icons.globe}<span
            >${host}</span
          ></span
        >
        <a
          class="link-hovercard__open"
          href=${href}
          target="_blank"
          rel="noopener noreferrer"
          data-link-reader-external
          @click=${(event: MouseEvent) => event.stopPropagation()}
          >${t("browser.openExternal")}${icons.externalLink}</a
        >
      </header>
      ${image ? html`<img class="link-hovercard__image" src=${image} alt="" @error=${() => failed(image)} @load=${position} />` : nothing}
      <section class="link-hovercard__body">
        <div class="link-hovercard__title">${title}</div>
        ${preview.description ? html`<p class="link-hovercard__description">${preview.description}</p>` : nothing}
      </section>`,
    card,
  );
}

export type PageActivation = {
  anchor: HTMLAnchorElement;
  href: string;
  client: GatewayBrowserClient;
  generation: number;
  recoveryScope: string;
  controller: AbortController;
  preview: ControlUiLinkPreview;
  failedImages: Set<string>;
};
