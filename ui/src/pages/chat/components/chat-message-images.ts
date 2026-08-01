import { html, noChange, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { until } from "lit/directives/until.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachments.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
  isLocalAttachmentPreviewAllowed,
} from "./chat-message-local-media.ts";
import {
  cacheManagedImageBlobUrl,
  isChatMediaResourceCurrent,
  isChatMediaResourceSubscriberActive,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  observeChatMediaResourceSubscriber,
  readManagedImageBlobUrl,
  releaseChatMediaResourceSubscriber,
  releaseManagedImageResourceSubscription,
  retainManagedImageBlobUrl,
  scheduleChatMediaResourceRefresh,
  trimManagedImageMissResources,
  type ChatMediaResource,
  type ImageBlock,
  type ImageRenderOptions,
  type RenderableImageBlock,
} from "./chat-message-media.ts";

const MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MANAGED_OUTGOING_IMAGE_RETRY_MS = 5_000;
type ManagedImageVariant = "full" | "thumbnail";

class ManagedImageResourceDirective extends AsyncDirective {
  private cacheKey: string | undefined;
  private image: RenderableImageBlock | undefined;
  private options: ImageRenderOptions | undefined;
  private renderImageElement:
    | ((image: RenderableImageBlock, previewUrl: string) => TemplateResult)
    | undefined;
  private onRequestUpdate: (() => void) | undefined;
  private requestVersion = 0;
  private readonly requestUpdate = () => this.onRequestUpdate?.();

  override render(
    image: RenderableImageBlock,
    options: ImageRenderOptions | undefined,
    renderImageElement: (image: RenderableImageBlock, previewUrl: string) => TemplateResult,
  ) {
    const requestVersion = ++this.requestVersion;
    this.image = image;
    this.options = options;
    this.renderImageElement = renderImageElement;
    if (!this.isConnected) {
      releaseChatMediaResourceSubscriber(this.requestUpdate);
      this.cacheKey = undefined;
      this.onRequestUpdate = options?.onRequestUpdate;
      return noChange;
    }

    const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(
      image.displayUrl,
      options,
      image.artifactId,
      "thumbnail",
    );
    const fullSubscriberScope = `${buildManagedOutgoingImageVariantUrl(image.displayUrl, "full")}::${
      image.artifactId?.trim() ?? ""
    }`;
    const cachedFullPreview = readManagedOutgoingImageBlobUrl(
      image.displayUrl,
      options,
      image.artifactId,
      "full",
    );
    if (
      (this.cacheKey !== undefined && this.cacheKey !== cacheKey) ||
      this.onRequestUpdate !== options?.onRequestUpdate
    ) {
      releaseChatMediaResourceSubscriber(this.requestUpdate);
    }
    this.cacheKey = cacheKey;
    this.onRequestUpdate = options?.onRequestUpdate;

    // A transcript shares one pane callback across many guarded rows. Lit owns
    // each image part, so only disconnecting that part may release its resource.
    if (this.onRequestUpdate) {
      observeChatMediaResourceSubscriber(this.onRequestUpdate, this.requestUpdate);
    }
    const subscriptionOptions = this.onRequestUpdate
      ? { ...options, onRequestUpdate: this.requestUpdate }
      : options;
    const preview = resolveManagedOutgoingImageBlobUrl(
      image.displayUrl,
      subscriptionOptions,
      image.artifactId,
      "thumbnail",
    )
      .then((previewUrl) => {
        if (previewUrl) {
          releaseManagedImageResourceSubscription(fullSubscriberScope, this.requestUpdate);
          return previewUrl;
        }
        if (
          !this.isConnected ||
          requestVersion !== this.requestVersion ||
          this.cacheKey !== cacheKey ||
          (this.onRequestUpdate && !isChatMediaResourceSubscriberActive(this.requestUpdate))
        ) {
          return null;
        }
        // Both variants share this directive subscriber, so disconnecting
        // the part releases and aborts the thumbnail and full resources.
        return resolveManagedOutgoingImageBlobUrl(
          image.displayUrl,
          subscriptionOptions,
          image.artifactId,
          "full",
        );
      })
      .then((previewUrl) =>
        previewUrl &&
        this.isConnected &&
        requestVersion === this.requestVersion &&
        this.cacheKey === cacheKey &&
        (!this.onRequestUpdate || isChatMediaResourceSubscriberActive(this.requestUpdate))
          ? renderImageElement(image, previewUrl)
          : nothing,
      );
    return until(
      preview,
      cachedFullPreview ? renderImageElement(image, cachedFullPreview) : nothing,
    );
  }

  protected override disconnected() {
    this.requestVersion += 1;
    releaseChatMediaResourceSubscriber(this.requestUpdate);
  }

  protected override reconnected() {
    if (this.image && this.renderImageElement) {
      // Guarded transcript rows can skip their next pane render. Reinstall the
      // image promise and its subscriber directly when Lit reconnects its part.
      this.setValue(this.render(this.image, this.options, this.renderImageElement));
    }
  }
}

const renderManagedImageResource = directive(ManagedImageResourceDirective);

export function resolveRenderableMessageImages(
  images: ImageBlock[],
  opts?: ImageRenderOptions,
): RenderableImageBlock[] {
  return images.flatMap((img) => {
    const isLocalImage = isLocalAssistantAttachmentSource(img.url);
    const localMediaPreviewRoots = opts?.localMediaPreviewRoots ?? [];
    // Until bootstrap supplies roots, let authenticated Gateway metadata decide.
    const canProxyLocalImage =
      isLocalImage &&
      (localMediaPreviewRoots.length === 0 ||
        isLocalAttachmentPreviewAllowed(img.url, localMediaPreviewRoots));
    if (isLocalImage && !canProxyLocalImage) {
      return [];
    }
    const availability = canProxyLocalImage
      ? resolveAssistantAttachmentAvailability(
          img.url,
          localMediaPreviewRoots,
          opts?.basePath,
          opts?.authToken,
          opts?.onRequestUpdate,
        )
      : { status: "available" as const };
    if (availability.status !== "available") {
      return [];
    }
    const displayUrl = canProxyLocalImage
      ? buildAssistantAttachmentUrl(img.url, opts?.basePath, availability.mediaTicket)
      : img.url;
    return [{ ...img, displayUrl }];
  });
}

export function renderMessageImages(images: RenderableImageBlock[], opts?: ImageRenderOptions) {
  if (images.length === 0) {
    return nothing;
  }

  const openImage = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const requestVersion = opts?.onRequestOpenImage?.();
    const managedSource = isManagedOutgoingImageSource(img.displayUrl);
    if (!managedSource) {
      openResolvedImage(opts?.onOpenImage, previewUrl, title, undefined, requestVersion);
      return;
    }

    const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(
      img.displayUrl,
      opts,
      img.artifactId,
      "full",
    );
    const cachedFull = readManagedOutgoingImageBlobUrl(
      img.displayUrl,
      opts,
      img.artifactId,
      "full",
    );
    if (cachedFull) {
      const release = opts?.onOpenImage ? retainManagedImageBlobUrl(cacheKey) : undefined;
      openResolvedImage(opts?.onOpenImage, cachedFull, title, release, requestVersion);
      return;
    }

    if (!opts?.onOpenImage) {
      const pendingWindow = reserveExternalWindowForDeferredNavigation();
      void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full")
        .then((freshUrl) => {
          const release = freshUrl ? retainManagedImageBlobUrl(cacheKey) : undefined;
          const safeUrl = freshUrl
            ? resolveSafeExternalUrl(freshUrl, window.location.href, { allowDataImage: true })
            : null;
          if (!safeUrl) {
            release?.();
            pendingWindow?.close();
          } else if (pendingWindow) {
            pendingWindow.location.replace(safeUrl);
            window.setTimeout(() => release?.(), 30_000);
          } else {
            openExternalUrlSafe(safeUrl, { allowDataImage: true });
            window.setTimeout(() => release?.(), 30_000);
          }
        })
        .catch(() => pendingWindow?.close());
      return;
    }
    void resolveManagedOutgoingImageBlobUrl(img.displayUrl, opts, img.artifactId, "full")
      .then((freshUrl) => {
        if (!freshUrl) {
          return;
        }
        const release = cacheKey ? retainManagedImageBlobUrl(cacheKey) : undefined;
        openResolvedImage(opts.onOpenImage, freshUrl, title, release, requestVersion);
      })
      .catch(() => {});
  };

  const renderImageElement = (img: RenderableImageBlock, previewUrl: string) => {
    const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
    const isManaged = isManagedOutgoingImageSource(img.displayUrl);
    return html`
      <span class="chat-image-frame">
        <button
          type="button"
          class="chat-message-image-button"
          aria-label=${t("chat.imageLightbox.open", { title })}
          @click=${() => openImage(img, previewUrl)}
        >
          <img
            src=${previewUrl}
            alt=${title}
            class="chat-message-image"
            width=${img.width ?? nothing}
            height=${img.height ?? nothing}
          />
        </button>
        ${isManaged
          ? renderManagedImageActions(img, opts, () => openImage(img, previewUrl))
          : nothing}
      </span>
    `;
  };

  const renderImage = (img: RenderableImageBlock) => {
    if (!isManagedOutgoingImageSource(img.displayUrl)) {
      return renderImageElement(img, img.displayUrl);
    }
    return renderManagedImageResource(img, opts, renderImageElement);
  };

  return html` <div class="chat-message-images">${images.map((img) => renderImage(img))}</div> `;
}

function isManagedOutgoingImageSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("/api/chat/media/outgoing/")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith("/api/chat/media/outgoing/")
    );
  } catch {
    return false;
  }
}

function resolveManagedOutgoingImageRequesterSessionKey(source: string): string | null {
  try {
    const parsed = new URL(source, window.location.origin);
    const parts = parsed.pathname.split("/");
    const encodedSessionKey = parts[5];
    return encodedSessionKey ? decodeURIComponent(encodedSessionKey) : null;
  } catch {
    return null;
  }
}

function resolveManagedOutgoingImageBlobUrlCacheKey(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): string {
  const authToken = opts?.authToken?.trim() ?? "";
  return `${buildManagedOutgoingImageVariantUrl(source, variant)}::${authToken}::${artifactId?.trim() ?? ""}`;
}

function readManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): string | undefined {
  return readManagedImageBlobUrl(
    resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId, variant),
  );
}

async function resolveManagedOutgoingImageBlobUrl(
  source: string,
  opts?: ImageRenderOptions,
  artifactId?: string,
  variant: ManagedImageVariant = "thumbnail",
): Promise<string | null> {
  const cacheKey = resolveManagedOutgoingImageBlobUrlCacheKey(source, opts, artifactId, variant);
  const resource = observeChatMediaResource<string | null>(
    "managed-image",
    cacheKey,
    opts?.onRequestUpdate,
    `${buildManagedOutgoingImageVariantUrl(source, variant)}::${artifactId?.trim() ?? ""}`,
  );
  const cached = readManagedImageBlobUrl(cacheKey);
  if (cached) {
    resource.value = cached;
    resource.retryAttempted = false;
    resource.unavailableAt = undefined;
    return cached;
  }
  if (resource.value === null) {
    if (
      resource.retryAttempted ||
      resource.unavailableAt === undefined ||
      Date.now() - resource.unavailableAt < MANAGED_OUTGOING_IMAGE_RETRY_MS
    ) {
      return null;
    }
    if (resource.refresh) {
      window.clearTimeout(resource.refresh.timer);
      resource.refresh = undefined;
    }
    resource.retryAttempted = true;
    resource.value = undefined;
  }
  if (!resource.pending) {
    const controller = new AbortController();
    resource.abortController = controller;
    const pending = (async () => {
      const blob = await fetchManagedOutgoingImageBlob(
        source,
        opts,
        artifactId,
        variant,
        controller,
      );
      if (!blob) {
        return markManagedOutgoingImageUnavailable(resource);
      }
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      const blobUrl = URL.createObjectURL(blob);
      cacheManagedImageBlobUrl(cacheKey, blobUrl);
      resource.value = blobUrl;
      resource.retryAttempted = false;
      resource.unavailableAt = undefined;
      return blobUrl;
    })().finally(() => {
      if (resource.abortController === controller) {
        resource.abortController = undefined;
      }
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      trimManagedImageMissResources();
      notifyChatMediaResourceSubscribers(resource);
    });
    resource.pending = pending;
  }
  return resource.pending;
}

function buildManagedOutgoingImageVariantUrl(source: string, variant: ManagedImageVariant): string {
  try {
    const parsed = new URL(source, window.location.origin);
    parsed.pathname = parsed.pathname.replace(/\/(?:full|thumbnail)$/u, `/${variant}`);
    return source.startsWith("http") ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
  } catch {
    return source.replace(/\/(?:full|thumbnail)(?=$|\?)/u, `/${variant}`);
  }
}

async function fetchManagedOutgoingImageBlob(
  source: string,
  opts: ImageRenderOptions | undefined,
  artifactId: string | undefined,
  variant: ManagedImageVariant,
  controller = new AbortController(),
): Promise<Blob | null> {
  const requesterSessionKey = resolveManagedOutgoingImageRequesterSessionKey(source);
  const artifactDownload =
    requesterSessionKey && artifactId && opts?.resolveArtifactDownload
      ? await opts
          .resolveArtifactDownload({ sessionKey: requesterSessionKey, artifactId })
          .catch(() => null)
      : null;
  const requestUrl = buildManagedOutgoingImageVariantUrl(artifactDownload?.url ?? source, variant);
  const headers = new Headers({ Accept: "image/*" });
  const authToken = opts?.authToken?.trim();
  if (!artifactDownload && authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  if (!artifactDownload && requesterSessionKey) {
    headers.set("x-openclaw-requester-session-key", requesterSessionKey);
  }
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("managed outgoing image fetch timed out", "TimeoutError"));
  }, MANAGED_OUTGOING_IMAGE_FETCH_TIMEOUT_MS);
  try {
    // Managed media is a Gateway API at the origin root. Rebasing it under
    // the Control UI mount path serves the HTML shell instead of image bytes.
    const res = await fetch(requestUrl, {
      method: "GET",
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const blob = await res.blob();
    return blob.type.startsWith("image/") ? blob : null;
  } catch {
    // Image rendering and actions are optional; keep the message usable.
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function imageExtensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  switch (normalized) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/pjpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tif";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/apng":
      return "apng";
    case "image/jxl":
      return "jxl";
    default:
      break;
  }
  const subtype = normalized.startsWith("image/") ? normalized.slice("image/".length) : "";
  return /^[a-z0-9]{1,10}$/u.test(subtype) ? subtype : "img";
}

function sanitizeImageFileName(value: string): string {
  const invalidCharacters = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  let sanitized = "";
  for (const character of value) {
    sanitized += character.charCodeAt(0) < 32 || invalidCharacters.has(character) ? "_" : character;
  }
  return sanitized;
}

function imageDownloadFileName(img: RenderableImageBlock, blob: Blob): string {
  const rawName = sanitizeImageFileName(img.alt?.trim() || "generated-image");
  const stem = rawName.replace(/\.[a-z0-9]{1,10}$/iu, "") || "generated-image";
  return `${stem}.${imageExtensionForMimeType(blob.type || "image/png")}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("Image conversion is not supported");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create an image conversion context");
    }
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
        } else {
          reject(new Error("Could not convert image for clipboard"));
        }
      }, "image/png");
    });
  } finally {
    bitmap.close();
  }
}

function renderManagedImageActions(
  img: RenderableImageBlock,
  opts: ImageRenderOptions | undefined,
  onOpen: () => void,
) {
  const title = img.alt?.trim() || t("chat.imageLightbox.untitled");
  const download = async () => {
    try {
      const blob = await fetchManagedOutgoingImageBlob(
        img.displayUrl,
        opts,
        img.artifactId,
        "full",
      );
      if (blob) {
        downloadBlob(blob, imageDownloadFileName(img, blob));
      }
    } catch {
      // Image actions are optional UI affordances; keep the message usable.
    }
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        return;
      }
      const blob = fetchManagedOutgoingImageBlob(img.displayUrl, opts, img.artifactId, "full").then(
        (fetched) => {
          if (!fetched) {
            throw new Error("Managed image is unavailable");
          }
          return convertImageBlobToPng(fetched);
        },
      );
      void blob.catch(() => {});
      // ClipboardItem keeps the click's transient activation while its PNG promise resolves.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch {
      // Clipboard support varies by browser and secure-context policy.
    }
  };
  return html`
    <span class="chat-image-actions">
      <button
        type="button"
        class="chat-image-action"
        title=${t("chat.imageLightbox.openOriginal")}
        aria-label=${t("chat.imageLightbox.open", { title })}
        @click=${onOpen}
      >
        ${icons.externalLink}
      </button>
      <button
        type="button"
        class="chat-image-action"
        title=${t("chat.toolCards.downloadFile")}
        aria-label=${t("chat.toolCards.downloadFile")}
        @click=${() => void download()}
      >
        ${icons.download}
      </button>
      <button
        type="button"
        class="chat-image-action"
        title=${t("common.copy")}
        aria-label=${t("common.copy")}
        @click=${() => void copy()}
      >
        ${icons.copy}
      </button>
    </span>
  `;
}

function markManagedOutgoingImageUnavailable(resource: ChatMediaResource<string | null>): null {
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
