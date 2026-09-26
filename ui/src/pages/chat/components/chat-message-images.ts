import { html, noChange, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { Directive } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { t } from "../../../i18n/index.ts";
import {
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { showToast } from "../../../lib/toast.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { renderChatImageActions } from "./chat-image-actions.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
  resolveAssistantAttachmentAvailability,
  retryAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import { renderAssistantAttachmentStatusCard } from "./chat-message-attachment-status.ts";
import { loadManagedImageBlob, resolveManagedImageResource } from "./chat-message-image-loading.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isCanonicalInboundMediaSource,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceSubscriber,
  retainManagedImageBlobUrl,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

const CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS = 30_000;
const MIN_CHAT_IMAGE_PREVIEW_WIDTH = 160;

type RetainedInlineImage = {
  status: "retaining";
  previewUrl: string;
  timeout?: ReturnType<typeof setTimeout>;
};

function isInlineImageSource(source: string | undefined): source is string {
  return source?.startsWith("data:image/") === true || source?.startsWith("blob:") === true;
}

function imageTitle(image: ImageBlock): string {
  return image.alt?.trim() || image.fileName?.trim() || t("chat.imageLightbox.untitled");
}

class MessageImageResourceDirective extends AsyncDirective {
  private image: ImageBlock | undefined;
  private options: ImageRenderOptions | undefined;
  private element: HTMLImageElement | undefined;
  private managed = false;
  private pendingPreview: Promise<string | null> | undefined;
  private presentationKey = Symbol("image-presentation");
  private retained: RetainedInlineImage | { status: "unavailable" } | undefined;
  private admitted = false;
  private stopObserving: (() => void) | undefined;
  private readonly observeFrame = (element: Element | undefined) => {
    this.stopObserving?.();
    this.stopObserving = undefined;
    if (!element || !this.isConnected || this.admitted || isInlineImageSource(this.image?.url)) {
      return;
    }
    const presentationKey = this.presentationKey;
    this.stopObserving = observeChatAttachmentViewport(element, () => {
      if (presentationKey === this.presentationKey) {
        this.admit();
      }
    });
  };
  private readonly admit = () => {
    if (this.isConnected && !this.admitted) {
      this.admitted = true;
      this.stopObserving?.();
      this.stopObserving = undefined;
      this.refreshImage();
    }
  };
  // Resource updates stay in this part; row ResizeObserver owns layout changes.
  private readonly refreshImage = () => {
    if (this.isConnected && this.image) {
      this.setValue(this.render(this.image, this.options));
    }
  };
  private readonly onSettled = (event: Event, image: ImageBlock) => {
    // A removed IMG may finish after denial; it no longer owns displayed pixels.
    const element = event.currentTarget;
    if (
      !this.isConnected ||
      this.image?.url !== image.url ||
      this.image?.artifactId !== image.artifactId ||
      !(element instanceof HTMLImageElement) ||
      !element.isConnected
    ) {
      return;
    }
    this.element = event.type === "load" ? element : undefined;
    if (
      this.retained?.status === "retaining" &&
      this.element?.getAttribute("src") !== this.retained.previewUrl
    ) {
      if (event.type === "error") {
        this.failRetainedImage();
      } else {
        this.releaseRetainedImage();
      }
    }
  };

  override render(image: ImageBlock, options: ImageRenderOptions | undefined) {
    const previous = this.image;
    if (previous?.url !== image.url || previous?.artifactId !== image.artifactId) {
      this.managed = image.url === undefined || isManagedOutgoingMediaSource(image.url);
      this.pendingPreview = undefined;
      this.releaseRetainedImage();
      // The gallery binds the exact submission/slot. Retain only pixels this
      // mounted IMG has loaded, never another pane's cached preview.
      this.retained =
        image.factIndex !== undefined &&
        previous &&
        isInlineImageSource(previous.url) &&
        previous.artifactId === image.artifactId &&
        image.url !== undefined &&
        isCanonicalInboundMediaSource(image.url) &&
        this.element?.getAttribute("src") === previous.url &&
        this.element.naturalWidth > 0
          ? { status: "retaining", previewUrl: previous.url }
          : undefined;
      const inlineReplacement =
        options?.localSubmission &&
        previous &&
        isInlineImageSource(previous.url) &&
        isInlineImageSource(image.url);
      if (!this.retained && !inlineReplacement) {
        this.element = undefined;
        this.admitted = false;
        this.presentationKey = Symbol("image-presentation");
      }
      releaseChatMediaResourceSubscriber(this.refreshImage);
    }
    this.image = image;
    this.options = options;
    if (!this.isConnected) {
      this.releaseRetainedImage();
      releaseChatMediaResourceSubscriber(this.refreshImage);
      return noChange;
    }
    // Admit network work before resolving metadata, artifact tickets, or blobs.
    // Local bytes and a mounted decoded handoff never wait for the observer.
    if (
      !this.admitted &&
      !isInlineImageSource(image.url) &&
      !this.retained &&
      typeof IntersectionObserver === "function"
    ) {
      return this.present(this.renderImagePlaceholder(image));
    }
    this.admitted = true;
    const onRequestUpdate = options?.onRequestUpdate;

    // Lit owns each image part. Reparent its stable subscription when the pane
    // callback changes without discarding its loaded resource.
    if (onRequestUpdate) {
      this.pendingPreview = undefined;
      observeChatMediaResourceSubscriber(onRequestUpdate, this.refreshImage);
    } else {
      releaseChatMediaResourceSubscriber(this.refreshImage);
    }
    const subscriptionOptions = onRequestUpdate
      ? { ...options, onRequestUpdate: this.refreshImage }
      : options;
    const source = image.url;
    if (source === undefined) {
      return this.renderManagedImage(image, options, subscriptionOptions);
    }
    const availability = resolveAssistantAttachmentAvailability(source, subscriptionOptions);
    const decodeFailed = this.retained?.status === "unavailable";
    // Tickets authorize new reads, not already decoded pixels. Only this
    // mounted image can survive an unconfirmed renewal; denial still clears it.
    const unconfirmed =
      availability.status === "checking" ||
      (availability.status === "unavailable" && availability.unconfirmed);
    const displayUrl =
      availability.status === "available"
        ? buildAssistantAttachmentUrl(
            source,
            options?.resourceBasePath,
            availability.mediaTicket,
            options,
            image.fileName,
          )
        : unconfirmed
          ? this.element?.getAttribute("src")
          : undefined;
    if (!displayUrl || decodeFailed) {
      this.element = undefined;
      if (!decodeFailed) {
        this.releaseRetainedImage();
      }
      const reason =
        availability.status === "unavailable"
          ? availability.reason
          : decodeFailed
            ? t("chat.imageLightbox.loadFailed")
            : undefined;
      if (reason === undefined) {
        return this.present(this.renderImagePlaceholder(image));
      }
      return this.present(
        this.renderImageFrame(
          image,
          renderAssistantAttachmentStatusCard({
            label: image.fileName ?? image.alt ?? t("chat.imageLightbox.untitled"),
            badge: t("chat.attachments.unavailable"),
            reason,
            path: isLocalAssistantAttachmentSource(source) ? source : undefined,
            onAllow:
              !decodeFailed && availability.status === "unavailable" && availability.canAllow
                ? () => retryAssistantAttachmentAvailability(source, subscriptionOptions, true)
                : undefined,
            onRetry:
              !decodeFailed && availability.status === "unavailable" && availability.recoverable
                ? () => retryAssistantAttachmentAvailability(source, subscriptionOptions)
                : undefined,
          }),
          "unavailable",
        ),
      );
    }
    if (!this.managed) {
      const retained = this.retained;
      if (
        availability.status === "available" &&
        retained?.status === "retaining" &&
        retained.timeout === undefined
      ) {
        // IMG keeps its current decoded request while the new src loads. One
        // native load/error boundary replaces the detached decode preloader.
        retained.timeout = setTimeout(
          () => this.failRetainedImage(),
          CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS,
        );
      }
      return this.present(this.renderImageElement(image, displayUrl, options));
    }
    return this.renderManagedImage(image, options, subscriptionOptions, displayUrl);
  }

  private renderManagedImage(
    image: ImageBlock,
    options: ImageRenderOptions | undefined,
    subscriptionOptions: ImageRenderOptions | undefined,
    source = image.url,
  ) {
    const resource = resolveManagedImageResource(source, subscriptionOptions, image.artifactId);
    const pending = resource.pending;
    // Standalone renders settle without opting into pane-owned automatic retries.
    if (!options?.onRequestUpdate && pending && this.pendingPreview !== pending) {
      this.pendingPreview = pending;
      void pending.then((previewUrl) => {
        if (this.pendingPreview === pending && this.isConnected && this.image) {
          this.pendingPreview = undefined;
          this.setValue(
            this.present(
              previewUrl
                ? this.renderImageElement(this.image, previewUrl, this.options)
                : this.renderImagePlaceholder(this.image, t("chat.imageLightbox.loadFailed")),
            ),
          );
        }
      });
    }
    return this.present(
      resource.value
        ? this.renderImageElement(image, resource.value, options)
        : this.renderImagePlaceholder(
            image,
            resource.value === null ? t("chat.imageLightbox.loadFailed") : undefined,
          ),
    );
  }

  private renderImageElement(
    img: ImageBlock,
    previewUrl: string | undefined,
    opts: ImageRenderOptions | undefined,
  ) {
    const title = imageTitle(img);
    return this.renderImageFrame(
      img,
      html`
        <button
          type="button"
          class="chat-message-image-button"
          aria-label=${t("chat.imageLightbox.open", { title })}
          aria-disabled=${previewUrl ? nothing : "true"}
          @focus=${this.admit}
          @click=${(event: MouseEvent) => {
            event.stopPropagation();
            if (previewUrl) {
              openMessageImage(img, previewUrl, opts);
            } else {
              this.admit();
            }
          }}
        >
          ${
            previewUrl
              ? html`<img
                  @load=${(event: Event) => this.onSettled(event, img)}
                  @error=${(event: Event) => this.onSettled(event, img)}
                  src=${previewUrl}
                  alt=${title}
                  referrerpolicy="no-referrer"
                  class="chat-message-image"
                  width=${img.width ?? nothing}
                  height=${img.height ?? nothing}
                />`
              : html`<span class="chat-image-skeleton skeleton" aria-hidden="true"></span>`
          }
        </button>
        ${
          this.managed && previewUrl
            ? renderChatImageActions(title, () =>
                loadManagedImageBlob(img.url, opts, img.artifactId),
              )
            : nothing
        }
      `,
      previewUrl ? undefined : "loading",
    );
  }

  private renderImageFrame(
    img: ImageBlock,
    content: TemplateResult | typeof nothing,
    state?: "loading" | "unavailable",
  ) {
    const sized =
      Number.isFinite(img.width) &&
      img.width! > 0 &&
      Number.isFinite(img.height) &&
      img.height! > 0;
    const pending = state === "loading";
    const compact = state === "unavailable";
    const ratio = sized ? img.width! / img.height! : 3 / 2;
    const previewWidth = sized
      ? img.width! < MIN_CHAT_IMAGE_PREVIEW_WIDTH
        ? MIN_CHAT_IMAGE_PREVIEW_WIDTH
        : Math.min(img.width!, 400, 360 * ratio)
      : 400;
    const width = compact ? Math.max(MIN_CHAT_IMAGE_PREVIEW_WIDTH, previewWidth) : previewWidth;
    const height = Math.min(360, width / ratio);
    // An in-flight metadata read is not a permission denial. Only confirmed
    // unavailable images use cards; loading stays plain until the read settles.
    // Unknown decoded images still use their intrinsic size, not the loading ratio.
    return html`<span
      ${ref(this.observeFrame)}
      class="chat-image-frame ${sized || pending || compact ? "chat-image-frame--image" : ""} ${this.managed && !compact ? "chat-image-frame--managed" : ""} ${compact ? "chat-image-frame--compact" : ""}"
      style=${`--chat-image-width: ${width}px; --chat-image-min-width: ${MIN_CHAT_IMAGE_PREVIEW_WIDTH}px; --chat-image-ratio: ${compact ? "auto" : `${width} / ${height}`}`}
      aria-busy=${pending ? "true" : "false"}
      role=${pending ? "status" : nothing}
      aria-label=${pending ? t("common.loading") : nothing}
      >${content}</span
    >`;
  }

  private renderImagePlaceholder(image: ImageBlock, reason?: string) {
    if (reason === undefined) {
      return this.renderImageElement(image, undefined, this.options);
    }
    return this.renderImageFrame(
      image,
      renderAssistantAttachmentStatusCard({
        label: image.fileName ?? image.alt ?? t("chat.imageLightbox.untitled"),
        badge: t("chat.attachments.unavailable"),
        reason,
        onRetry: this.managed
          ? () => {
              resolveManagedImageResource(
                image.url,
                this.options?.onRequestUpdate
                  ? { ...this.options, onRequestUpdate: this.refreshImage }
                  : this.options,
                image.artifactId,
                "thumbnail",
                true,
              );
              this.refreshImage();
            }
          : undefined,
      }),
      "unavailable",
    );
  }

  private releaseRetainedImage() {
    const retained = this.retained;
    this.retained = undefined;
    if (retained?.status === "retaining") {
      clearTimeout(retained.timeout);
    }
  }

  private failRetainedImage() {
    this.releaseRetainedImage();
    this.retained = { status: "unavailable" };
    this.refreshImage();
  }

  private present(value: unknown) {
    return html`${keyed(this.presentationKey, value)}`;
  }

  protected override disconnected() {
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.admitted = false;
    this.releaseRetainedImage();
    this.element = undefined;
    this.pendingPreview = undefined;
    this.presentationKey = Symbol("image-presentation");
    releaseChatMediaResourceSubscriber(this.refreshImage);
  }

  protected override reconnected() {
    // Guarded rows may skip the next pane render; reconnect their own resource.
    this.refreshImage();
  }
}

const renderMessageImageResource = directive(MessageImageResourceDirective);

function openMessageImage(
  img: ImageBlock,
  previewUrl: string,
  opts: ImageRenderOptions | undefined,
) {
  const title = imageTitle(img);
  const requestVersion = opts?.onRequestOpenImage?.();
  const images = opts?.galleryImages;
  const index = images?.indexOf(img) ?? -1;
  const onOpenImage = opts?.onOpenImage;
  const open = (item: ImageLightboxItem) => {
    const sizedItem = { ...item, width: img.width, height: img.height };
    const nextItem =
      images && images.length > 1 && index >= 0
        ? {
            ...sizedItem,
            gallery: {
              index,
              items: images.map(
                (image) =>
                  (retryFailed = false) =>
                    loadGalleryImage(image, opts, retryFailed),
              ),
            },
          }
        : sizedItem;
    if (requestVersion === undefined) {
      onOpenImage?.(nextItem);
    } else {
      onOpenImage?.(nextItem, requestVersion);
    }
  };
  if (img.url !== undefined && !isManagedOutgoingMediaSource(img.url)) {
    openResolvedImage(onOpenImage ? open : undefined, previewUrl, title);
    return;
  }

  if (onOpenImage) {
    const preview = resolveManagedImageResource(img.url, opts, img.artifactId);
    open({
      src: previewUrl,
      title,
      release: retainManagedImageBlobUrl(preview.cacheKey),
      loadFullResolution: () => loadGalleryImage(img, opts, true),
    });
    return;
  }

  const resource = resolveManagedImageResource(img.url, opts, img.artifactId, "full", true);
  if (resource.value) {
    openResolvedImage(undefined, resource.value, title);
    return;
  }

  const pendingWindow = reserveExternalWindowForDeferredNavigation();
  const failed = () => {
    pendingWindow?.close();
    showToast({ message: t("chat.imageLightbox.loadFailed") });
  };
  const pending = resource.pending ?? Promise.resolve(null);
  void pending
    .then((freshUrl) => {
      const safeUrl = freshUrl
        ? resolveSafeExternalUrl(freshUrl, window.location.href, { allowDataImage: true })
        : null;
      if (!safeUrl) {
        failed();
      } else if (pendingWindow) {
        pendingWindow.location.replace(safeUrl);
      } else {
        openResolvedImage(undefined, safeUrl, title);
      }
    })
    .catch(failed);
}

async function loadGalleryImage(
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

class MessageImagesDirective extends Directive {
  private slots: { image: ImageBlock; key: symbol }[] = [];
  private scope = "";
  private policyKey: string | undefined;
  private canonicalMessageKey: string | undefined;
  private localSubmission = false;

  override render(
    images: ImageBlock[],
    opts?: ImageRenderOptions,
    previews: TemplateResult[] = [],
  ) {
    const scope = JSON.stringify([
      opts?.connectionEpoch,
      opts?.authToken?.trim(),
      opts?.resourceBasePath,
      opts?.sessionKey,
      opts?.agentId,
    ]);
    // Custody keeps local ownership; imported history must end it even when
    // the outer row reuses the same submission key.
    const continuing =
      this.scope === scope &&
      (!this.localSubmission || opts?.localSubmission !== false) &&
      (this.canonicalMessageKey === opts?.canonicalMessageKey ||
        (this.localSubmission && !this.canonicalMessageKey));
    const localSubmission = continuing ? this.localSubmission : opts?.localSubmission === true;
    // Fact positions preserve selected image order, even when hooks reorder
    // content blocks. Partial/ambiguous receipts cannot borrow pixels.
    const adoptingSlots =
      continuing &&
      localSubmission &&
      images.length === this.slots.length &&
      this.slots.every(({ image }) => isInlineImageSource(image.url)) &&
      images.every((image) => image.factIndex !== undefined);
    const previousImages = adoptingSlots
      ? images.toSorted((left, right) => (left.factIndex ?? 0) - (right.factIndex ?? 0))
      : this.slots.map(({ image }) => image);
    const previousSlots = new Map(
      previousImages.map((image, index) => [image.factIndex, this.slots[index]?.key]),
    );
    this.slots = images.map((image, index) => {
      const slot = this.slots[index];
      const previous =
        image.factIndex !== undefined
          ? previousSlots.get(image.factIndex)
          : slot?.image.factIndex === undefined
            ? slot?.key
            : undefined;
      // Workspace hydration does not replace uploaded pixels. Their resource
      // still rechecks access; filesystem images discard the old presentation.
      const preservePresentation =
        this.policyKey === opts?.policyKey ||
        isInlineImageSource(image.url) ||
        (image.url !== undefined && isCanonicalInboundMediaSource(image.url));
      return {
        image,
        key: (continuing && preservePresentation && previous) || Symbol("image-slot"),
      };
    });
    this.scope = scope;
    this.policyKey = opts?.policyKey;
    this.canonicalMessageKey = opts?.canonicalMessageKey;
    this.localSubmission =
      localSubmission &&
      !(opts?.canonicalMessageKey && images.every((image) => image.factIndex !== undefined));
    const mediaCount = images.length + previews.length;
    if (!mediaCount) {
      return nothing;
    }
    const layoutClasses = [
      "chat-message-images",
      mediaCount === 1 ? "chat-message-images--single" : "chat-message-images--gallery",
      mediaCount === 2 || mediaCount === 4 ? "chat-message-images--two-column" : "",
      mediaCount === 5 ? "chat-message-images--five" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`<div class=${layoutClasses}>
      ${repeat(
        this.slots,
        ({ key }) => key,
        ({ image }) =>
          html`${renderMessageImageResource(image, { ...opts, galleryImages: opts?.galleryImages ?? images })}`,
      )}
      ${previews}
    </div>`;
  }
}

export const renderMessageImages = directive(MessageImagesDirective);
