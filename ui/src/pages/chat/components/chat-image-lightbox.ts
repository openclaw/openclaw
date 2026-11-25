import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { openResolvedImage } from "./chat-image-presentation.ts";

registerChatMediaEnglish();

export function isImageLightboxEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) => target instanceof HTMLElement && target.localName === "openclaw-image-lightbox",
    );
}

export function isInlineChatImage(node: Node): node is HTMLImageElement {
  return (
    node instanceof HTMLImageElement &&
    node.classList.contains("markdown-inline-image") &&
    Boolean(node.getAttribute("src")) &&
    !node.closest("a")
  );
}

function inlineChatImageIndex(root: HTMLElement, image: HTMLImageElement): number {
  // Only identify the clicked slot here; gallery membership comes from source Markdown.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let index = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isInlineChatImage(node)) {
      if (node === image) {
        return index;
      }
      index += 1;
    }
  }
  return -1;
}

function inlineChatImageFromEvent(event: Event): HTMLImageElement | null {
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
  return image && isInlineChatImage(image) ? image : null;
}

export function openInlineChatImage(
  event: Event,
  onOpenImage: ((item: ImageLightboxItem, index?: number) => void) | undefined,
  imageRoot?: HTMLElement,
): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  const image = inlineChatImageFromEvent(event);
  if (!image) {
    return false;
  }
  const index = imageRoot ? inlineChatImageIndex(imageRoot, image) : undefined;
  if (index === -1) {
    return false;
  }
  event.preventDefault();
  const src = image.currentSrc || image.src;
  const title = image.alt.trim() || t("chat.imageLightbox.untitled");
  openResolvedImage(
    index !== undefined && onOpenImage ? (item) => onOpenImage(item, index) : onOpenImage,
    src,
    title,
  );
  return true;
}
