import { fetchControlUiResource } from "../../../app/browser-http.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { chatImageRenditionWidth } from "./chat-image-rendition.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import {
  resolveManagedImageResource,
  readCachedManagedImageUrl,
  loadManagedImageBlob,
  managedImageInlineVariant,
} from "./chat-message-image-loading.ts";
import {
  buildAssistantAttachmentUrl,
  isCanonicalInboundMediaSource,
} from "./chat-message-local-media.ts";
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
  original = false,
): Promise<ImageLightboxItem | null> {
  let src: string | null;
  let release: (() => void) | undefined;
  if (image.url === undefined || isManagedOutgoingMediaSource(image.url)) {
    const resource = resolveManagedImageResource(
      image.url,
      opts,
      image.artifactId,
      original || readCachedManagedImageUrl(image.url, opts, image.artifactId, "full")
        ? "full"
        : managedImageInlineVariant(image),
      retryFailed,
      chatImageRenditionWidth("viewer"),
    );
    src = resource.value ?? (await resource.pending) ?? null;
    if (!src || !isChatMediaResourceCurrent(resource)) {
      return null;
    }
    release = retainManagedImageBlobUrl(resource.cacheKey);
  } else {
    const availability = await loadAssistantAttachmentAvailability(image.url, opts, retryFailed);
    if (availability?.status !== "available") {
      return null;
    }
    src = buildAssistantAttachmentUrl(
      image.url,
      opts?.resourceBasePath,
      availability.mediaTicket,
      opts,
      image.fileName,
      original ? undefined : "thumbnail",
      chatImageRenditionWidth("viewer"),
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
    readOriginalBlob: () => readImageOriginalBlob(image, opts),
  };
}

export async function readImageOriginalBlob(
  image: ImageBlock,
  opts?: ImageRenderOptions,
): Promise<Blob> {
  if (image.url === undefined || isManagedOutgoingMediaSource(image.url)) {
    return await loadManagedImageBlob(image.url, opts, image.artifactId);
  }
  const original = await loadGalleryImage(image, opts, true, true);
  if (!original) {
    throw new Error("Image download is unavailable");
  }
  try {
    const response = await fetchControlUiResource(original.src, {
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      throw new Error("Image download failed");
    }
    return await response.blob();
  } finally {
    original.release?.();
  }
}

export function openMessageImage(
  img: ImageBlock,
  previewUrl: string,
  opts: ImageRenderOptions | undefined,
) {
  const safePreviewUrl = resolveSafeExternalUrl(previewUrl, window.location.href, {
    allowDataImage: true,
  });
  if (!safePreviewUrl) {
    return;
  }
  const title = imageTitle(img);
  const requestVersion = opts?.onRequestOpenImage?.();
  const images = opts?.galleryImages;
  const index = images?.indexOf(img) ?? -1;
  const onOpenImage = opts?.onOpenImage;
  const open = (item: ImageLightboxItem) => {
    const nextItem = { ...item, width: img.width, height: img.height };
    if (images && images.length > 1 && index >= 0) {
      nextItem.gallery = {
        index,
        items: images.map(
          (image) =>
            (retryFailed = false) =>
              loadGalleryImage(image, opts, retryFailed),
        ),
      };
    }
    if (requestVersion === undefined) {
      onOpenImage?.(nextItem);
    } else {
      onOpenImage?.(nextItem, requestVersion);
    }
  };
  const managed = img.url === undefined || isManagedOutgoingMediaSource(img.url);
  if (onOpenImage) {
    const preview = managed
      ? resolveManagedImageResource(
          img.url,
          opts,
          img.artifactId,
          managedImageInlineVariant(img),
          false,
          chatImageRenditionWidth("inline"),
        )
      : undefined;
    const bounded = managed
      ? managedImageInlineVariant(img) === "thumbnail"
      : img.url !== undefined && isCanonicalInboundMediaSource(img.url);
    open({
      src: safePreviewUrl,
      title,
      release: preview ? retainManagedImageBlobUrl(preview.cacheKey) : undefined,
      loadDisplayImage: bounded ? () => loadGalleryImage(img, opts, true) : undefined,
      readOriginalBlob: () => readImageOriginalBlob(img, opts),
    });
  } else {
    openResolvedImage(undefined, previewUrl, title);
  }
}
