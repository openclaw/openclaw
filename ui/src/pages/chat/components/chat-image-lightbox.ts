import { html, nothing } from "lit";
import "../../../components/image-lightbox.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";

export function inlineChatImageFromEvent(event: Event): HTMLImageElement | null {
  const target = event
    .composedPath()
    .find(
      (candidate): candidate is HTMLElement =>
        candidate instanceof HTMLElement &&
        (candidate.classList.contains("markdown-inline-image") ||
          candidate.classList.contains("markdown-inline-image-button")),
    );
  const image =
    target instanceof HTMLImageElement
      ? target
      : (target?.querySelector<HTMLImageElement>(".markdown-inline-image") ?? null);
  return image?.closest("a") ? null : image;
}

export function openInlineChatImage(
  event: Event,
  onOpenImage: ((item: ImageLightboxItem) => void) | undefined,
) {
  const image = inlineChatImageFromEvent(event);
  if (!image || !onOpenImage) {
    return;
  }
  event.preventDefault();
  const title = image.alt.trim() || t("chat.imageLightbox.untitled");
  onOpenImage({ src: image.currentSrc || image.src, title });
}

export function renderChatImageLightbox(
  item: ImageLightboxItem | null | undefined,
  onClose: (() => void) | undefined,
) {
  if (!item || !onClose) {
    return nothing;
  }
  return html`
    <openclaw-image-lightbox
      src=${item.src}
      title=${item.title}
      @image-lightbox-close=${onClose}
    ></openclaw-image-lightbox>
  `;
}
