import { Show } from "solid-js";
import type { ControlUiLinkPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createPreviewRenderer } from "./link-reader-preview-root.ts";
import { Icon } from "./solid/icon.tsx";
import "../styles/link-hovercard.css";

type PagePreview = {
  href: string;
  fallbackTitle: string;
  preview: ControlUiLinkPreview;
  failedImages: ReadonlySet<string>;
  failed: (src: string) => void;
  position: () => void;
};

const renderPageContent = createPreviewRenderer<PagePreview>((props) => {
  const host = () => new URL(props.value.href).host;
  const title = () => props.value.preview.title || props.value.fallbackTitle || host();
  const image = () => {
    const src = props.value.preview.imageDataUrl;
    return src && !props.value.failedImages.has(src) ? src : undefined;
  };
  const favicon = () => {
    const src = props.value.preview.faviconDataUrl;
    return src && !props.value.failedImages.has(src) ? src : undefined;
  };
  return (
    <>
      <header class="link-hovercard__header">
        <span class="link-hovercard__identity">
          <Show when={favicon()} fallback={<Icon name="globe" />}>
            {(src) => (
              <img
                src={src()}
                alt=""
                onError={() => props.value.failed(src())}
                onLoad={() => props.value.position()}
              />
            )}
          </Show>
          <span>{host()}</span>
        </span>
        <a
          class="link-hovercard__open"
          href={props.value.href}
          target="_blank"
          rel="noopener noreferrer"
          data-link-reader-external=""
          onClick={(event) => event.stopPropagation()}
        >
          {t("browser.openExternal")}
          <Icon name="externalLink" />
        </a>
      </header>
      <Show when={image()}>
        {(src) => (
          <img
            class="link-hovercard__image"
            src={src()}
            alt=""
            onError={() => props.value.failed(src())}
            onLoad={() => props.value.position()}
          />
        )}
      </Show>
      <section class="link-hovercard__body">
        <div class="link-hovercard__title">{title()}</div>
        <Show when={props.value.preview.description}>
          <p class="link-hovercard__description">{props.value.preview.description}</p>
        </Show>
      </section>
    </>
  );
});

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
  card.setAttribute("aria-label", preview.title || fallbackTitle || new URL(href).host);
  renderPageContent(
    card,
    { href, fallbackTitle, preview, failedImages, failed, position },
    position,
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
