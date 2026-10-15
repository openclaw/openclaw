import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";

export function LightboxAction(props: {
  class: string;
  label: string;
  disabled: boolean;
  action: () => unknown;
  children: JSX.Element;
}) {
  return (
    <button
      class={`action ${props.class}`}
      type="button"
      aria-label={t(props.label)}
      aria-disabled={props.disabled ? "true" : "false"}
      onClick={() => props.action()}
    >
      {props.children}
    </button>
  );
}

export function LightboxChrome(props: {
  title: string;
  originalUrl: string;
  resolvingOriginal: boolean;
  isVideo: boolean;
  onClose: (event?: Event) => void;
  children: JSX.Element;
}) {
  return (
    <section class="lightbox">
      <LightboxHeader title={props.title} isVideo={props.isVideo} onClose={props.onClose} />
      {props.children}
      <LightboxFooter originalUrl={props.originalUrl} resolvingOriginal={props.resolvingOriginal} />
    </section>
  );
}

function LightboxHeader(props: {
  title: string;
  isVideo: boolean;
  onClose: (event?: Event) => void;
}) {
  return (
    <header class="header">
      <strong class="title">{props.title}</strong>
      <div class="actions">
        <button
          class="action close"
          type="button"
          autofocus
          aria-label={
            props.isVideo ? t("chat.mediaPlayer.closeVideoPreview") : t("chat.imageLightbox.close")
          }
          onClick={() => props.onClose()}
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  );
}

function LightboxFooter(props: { originalUrl: string; resolvingOriginal: boolean }) {
  return (
    <Show when={props.originalUrl || props.resolvingOriginal}>
      <openclaw-modal-actions class="lightbox-footer">
        <a
          class="action open-original"
          href={props.originalUrl || undefined}
          aria-disabled={props.originalUrl ? "false" : "true"}
          tabindex={props.originalUrl ? 0 : -1}
          target="_blank"
          rel="noreferrer"
          aria-label={t("chat.imageLightbox.openOriginal")}
        >
          <span class="open-original-label">{t("chat.imageLightbox.openOriginal")}</span>
          <span class="open-original-icon" aria-hidden="true">
            <Icon name="externalLink" />
          </span>
        </a>
      </openclaw-modal-actions>
    </Show>
  );
}

export function lightboxImageStyle(image: ImageLightboxItem | undefined) {
  const width = image?.width;
  const height = image?.height;
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
    ? `width: min(${width}px, 100cqw, calc(100cqh * ${width / height}))`
    : undefined;
}
