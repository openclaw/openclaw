import type { ChatImageRenditionWidth } from "../../../../../src/shared/chat-image-renditions.js";
import { fetchControlUiResource, subscribeBrowserAuthRestored } from "../../../app/browser-http.ts";
import { buildChatMediaFetchHeaders } from "./chat-media-playback.ts";
import {
  isManagedOutgoingMediaSource,
  resolveManagedOutgoingMediaSessionKey,
} from "./chat-message-attachment-availability.ts";
import { applyResourceBasePath } from "./chat-message-local-media.ts";
import {
  cacheManagedImageBlob,
  clearChatMediaResourceRefresh,
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  readManagedImageBlob,
  readManagedImageBlobUrl,
  scheduleChatMediaResourceRefresh,
  trimManagedImageMissResources,
  type ChatMediaResource,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MANAGED_OUTGOING_IMAGE_RETRY_MS = 5_000;
type ManagedImageVariant = "full" | "thumbnail";

export function managedImageInlineVariant(image: ImageBlock): ManagedImageVariant {
  // Bounded still previews intentionally do not encode GIF animation.
  return image.mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "image/gif"
    ? "full"
    : "thumbnail";
}

function managedImageResourceIdentity(
  source: string | undefined,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
  previewWidth: ChatImageRenditionWidth = 960,
) {
  const variantUrl = source
    ? buildManagedOutgoingImageVariantUrl(source, variant, opts?.resourceBasePath, previewWidth)
    : undefined;
  const authToken = opts?.authToken?.trim() ?? "";
  const artifactKey = artifactId?.trim() ?? "";
  const cacheKey = JSON.stringify([
    opts?.connectionEpoch,
    opts?.resourceBasePath,
    opts?.sessionKey,
    opts?.agentId,
    opts?.policyKey,
    authToken,
    variantUrl,
    artifactKey,
    variant,
    variant === "thumbnail" ? previewWidth : undefined,
  ]);
  return {
    cacheKey,
    subscriberScope: `${variantUrl}::${artifactKey}::${variant}::${variant === "thumbnail" ? previewWidth : ""}`,
  };
}

export function readCachedManagedImageUrl(
  source: string | undefined,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
  previewWidth: ChatImageRenditionWidth = 960,
) {
  return readManagedImageBlobUrl(
    managedImageResourceIdentity(source, opts, artifactId, variant, previewWidth).cacheKey,
  );
}

export function resolveManagedImageResource(
  source: string | undefined,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
  retryFailed = false,
  previewWidth: ChatImageRenditionWidth = 960,
): ChatMediaResource<string | null> {
  const { cacheKey, subscriberScope } = managedImageResourceIdentity(
    source,
    opts,
    artifactId,
    variant,
    previewWidth,
  );
  const resource = observeChatMediaResource<string | null>(
    "managed-image",
    cacheKey,
    opts?.onRequestUpdate,
    subscriberScope,
  );
  if (resource.subscribers.size > 0 && !resource.releaseAuthRecovery) {
    resource.releaseAuthRecovery = subscribeBrowserAuthRestored(() => {
      if (!isChatMediaResourceCurrent(resource) || resource.value !== null) {
        return;
      }
      resource.value = undefined;
      resource.retryAttempted = false;
      resource.unavailableAt = undefined;
      clearChatMediaResourceRefresh(resource);
      notifyChatMediaResourceSubscribers(resource);
    });
  }
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    resource.value = cached;
    resource.retryAttempted = false;
    resource.unavailableAt = undefined;
    return resource;
  }
  if (resource.value === null) {
    if (
      !retryFailed &&
      (resource.retryAttempted ||
        resource.unavailableAt === undefined ||
        Date.now() - resource.unavailableAt < MANAGED_OUTGOING_IMAGE_RETRY_MS)
    ) {
      return resource;
    }
    // A render or explicit retry can beat the queued refresh after its deadline.
    clearChatMediaResourceRefresh(resource);
    resource.retryAttempted = true;
  }
  resource.value = undefined;
  if (!resource.pending) {
    const controller = new AbortController();
    resource.abortController = controller;
    resource.pending = (async () => {
      const blob = await fetchManagedImageBlob(
        source,
        opts,
        artifactId,
        variant,
        controller,
        previewWidth,
      );
      if (!blob) {
        return markManagedImageUnavailable(resource);
      }
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      const blobUrl = cacheManagedImageBlob(cacheKey, blob);
      resource.value = blobUrl;
      resource.retryAttempted = false;
      resource.unavailableAt = undefined;
      return blobUrl;
    })().finally(() => {
      resource.abortController = undefined;
      resource.pending = undefined;
      if (resource.value === null && resource.subscribers.size === 0) {
        trimManagedImageMissResources();
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  }
  return resource;
}

function buildManagedOutgoingImageVariantUrl(
  source: string,
  variant: ManagedImageVariant,
  resourceBasePath?: string,
  previewWidth: ChatImageRenditionWidth = 960,
): string {
  try {
    const parsed = new URL(source, window.location.origin);
    parsed.pathname = parsed.pathname.replace(/\/(?:full|thumbnail)$/u, `/${variant}`);
    if (variant === "thumbnail") {
      // Thumbnails are immutable in HTTP caches; replace pre-byte-limit renditions.
      parsed.searchParams.set("v", "4");
      parsed.searchParams.set("width", String(previewWidth));
    }
    if (/^https?:\/\//iu.test(source)) {
      return parsed.href;
    }
    return applyResourceBasePath(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
      resourceBasePath,
    );
  } catch {
    return source.replace(/\/(?:full|thumbnail)(?=$|[?#])/u, `/${variant}`);
  }
}

async function fetchManagedImageBlob(
  source: string | undefined,
  opts: ImageRenderOptions | undefined,
  artifactId: string | undefined,
  variant: ManagedImageVariant,
  controller: AbortController,
  previewWidth: ChatImageRenditionWidth,
): Promise<Blob | null> {
  const requesterSessionKey = source
    ? resolveManagedOutgoingMediaSessionKey(source)
    : opts?.sessionKey;
  const artifactDownload =
    requesterSessionKey && artifactId && opts?.resolveArtifactDownload
      ? await opts
          .resolveArtifactDownload(
            {
              sessionKey: requesterSessionKey,
              artifactId,
              variant,
              ...(variant === "thumbnail" ? { previewWidth } : {}),
            },
            controller.signal,
          )
          .catch(() => null)
      : null;
  if (controller.signal.aborted) {
    return null;
  }
  if (artifactDownload?.blob) {
    return artifactDownload.blob.type.startsWith("image/") ? artifactDownload.blob : null;
  }
  const imageSource = artifactDownload?.url ?? source;
  if (!imageSource || (!source && !imageSource.startsWith("data:image/"))) {
    return null;
  }
  const requestUrl = isManagedOutgoingMediaSource(imageSource)
    ? buildManagedOutgoingImageVariantUrl(
        imageSource,
        variant,
        opts?.resourceBasePath,
        previewWidth,
      )
    : imageSource;
  const headers = buildChatMediaFetchHeaders(artifactDownload ? undefined : opts?.authToken);
  headers.set("Accept", "image/*");
  if (!artifactDownload && requesterSessionKey) {
    headers.set("x-openclaw-requester-session-key", requesterSessionKey);
  }
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException("managed outgoing image fetch timed out", "TimeoutError"));
  }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
  try {
    // Root deployments use /api directly; subpath deployments expose the same
    // media route beneath the configured Control UI base path.
    const response = await fetchControlUiResource(requestUrl, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return blob.type.startsWith("image/") ? blob : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function loadManagedImageBlob(
  source: string | undefined,
  opts?: ImageRenderOptions,
  artifactId?: string,
): Promise<Blob> {
  const resource = resolveManagedImageResource(source, opts, artifactId, "full", true);
  if (resource.pending) {
    await resource.pending;
  }
  const blob = readManagedImageBlob(resource.cacheKey);
  if (!blob || !isChatMediaResourceCurrent(resource)) {
    throw new Error("managed image is unavailable");
  }
  return blob;
}

function markManagedImageUnavailable(resource: ChatMediaResource<string | null>): null {
  if (!isChatMediaResourceCurrent(resource)) {
    return null;
  }
  resource.value = null;
  resource.unavailableAt = Date.now();
  if (!resource.retryAttempted) {
    scheduleChatMediaResourceRefresh(resource, Date.now() + MANAGED_OUTGOING_IMAGE_RETRY_MS, () => {
      if (resource.value !== null) {
        return;
      }
      // A missing preview gets one lifecycle-owned retry, never a polling loop.
      resource.retryAttempted = true;
      resource.value = undefined;
      resource.unavailableAt = undefined;
      notifyChatMediaResourceSubscribers(resource);
    });
  }
  return null;
}
