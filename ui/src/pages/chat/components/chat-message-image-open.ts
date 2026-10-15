import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import { resolveManagedImageResource } from "./chat-message-image-loading.ts";
import { buildAssistantAttachmentUrl } from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  retainManagedImageBlobUrl,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

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

export async function loadGalleryImage(
  image: ImageBlock,
  opts: ImageRenderOptions | undefined,
  retryFailed: boolean,
): Promise<ImageLightboxItem | null> {
  let src: string | null;
  let release: (() => void) | undefined;
  if (image.url === undefined || isManagedOutgoingMediaSource(image.url)) {
    const resource = resolveManagedImageResource(
      image.url,
      opts,
      image.artifactId,
      "full",
      retryFailed,
    );
    src = resource.value ?? (await resource.pending) ?? null;
    if (!src || !isChatMediaResourceCurrent(resource)) {
      return null;
    }
    release = retainManagedImageBlobUrl(resource.cacheKey);
  } else {
    const availability = await loadAssistantAttachmentAvailability(image.url, opts);
    if (availability?.status !== "available") {
      return null;
    }
    src = buildAssistantAttachmentUrl(
      image.url,
      opts?.resourceBasePath,
      availability.mediaTicket,
      opts,
      image.fileName,
    );
  }
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return null;
  }
  return {
    src: safeSrc,
    title: imageTitle(image),
    width: image.width,
    height: image.height,
    release,
  };
}
