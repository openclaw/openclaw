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

export function LightboxHeader(props: {
  title: string;
  originalUrl: string;
  resolvingOriginal: boolean;
  isVideo: boolean;
  onClose: (event?: Event) => void;
}) {
  return (
    <header class="header">
      <strong class="title">{props.title}</strong>
      <div class="actions">
        <Show when={props.originalUrl || props.resolvingOriginal}>
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
        </Show>
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
