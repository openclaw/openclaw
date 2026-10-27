import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ImageBlock } from "./chat-message-media.ts";

registerChatMediaEnglish();

export function openResolvedImage(
  onOpenImage: ((item: ImageLightboxItem, requestVersion?: number) => void) | undefined,
  src: string,
  title: string,
  release?: () => void,
  requestVersion?: number,
) {
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return;
  }
  if (onOpenImage) {
    const item: ImageLightboxItem = { src: safeSrc, title, ...(release ? { release } : {}) };
    if (requestVersion === undefined) {
      onOpenImage(item);
    } else {
      onOpenImage(item, requestVersion);
    }
    return;
  }
  release?.();
  openExternalUrlSafe(safeSrc, { allowDataImage: true });
}

export function imageTitle(image: ImageBlock): string {
  return image.alt?.trim() || image.fileName?.trim() || t("chat.imageLightbox.untitled");
}
