import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal, onCleanup, useContext } from "solid-js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import {
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../../lib/open-external-url.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { LitContent, SolidContentPresentation } from "../../../lit/solid-content.tsx";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { renderChatImageActions } from "./chat-image-actions.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
  resolveAssistantAttachmentAvailability,
  retryAssistantAttachmentAvailability,
  retainAssistantImage,
  takeRetainedAssistantImage,
} from "./chat-message-attachment-availability.ts";
import {
  AssistantAttachmentStatusCard,
  type AssistantAttachmentStatusCardProps,
} from "./chat-message-attachment-status-solid.tsx";
import {
  loadManagedImageBlob,
  readCachedManagedImageUrl,
  resolveManagedImageResource,
} from "./chat-message-image-loading.ts";
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
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";

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

type ImagePresentation = {
  image: ImageBlock;
  key?: symbol;
  managed: boolean;
  previewUrl?: string;
  state?: "loading" | "unavailable";
  actions?: Pick<AssistantAttachmentStatusCardProps, "path" | "onAllow" | "onRetry">;
  reason?: string;
};

class MessageImagePresentation {
  private active = true;
  constructor(private readonly notify: () => void) {}
  private image: ImageBlock | undefined;
  private options: ImageRenderOptions | undefined;
  private element: HTMLImageElement | undefined;
  private previewElement: HTMLImageElement | undefined;
  private managed = false;
  private pendingPreview: Promise<string | null> | undefined;
  private presentationKey = Symbol("image-presentation");
  private retained: RetainedInlineImage | { status: "unavailable" } | undefined;
  private admitted = false;
  private stopObserving: (() => void) | undefined;
  readonly observeFrame = (element: Element | undefined) => {
    this.stopObserving?.();
    this.stopObserving = undefined;
    if (!element || !this.active || this.admitted || isInlineImageSource(this.image?.url)) {
      return;
    }
    const presentationKey = this.presentationKey;
    this.stopObserving = observeChatAttachmentViewport(element, () => {
      if (presentationKey === this.presentationKey) {
        this.admit();
      }
    });
  };
  readonly admit = () => {
    if (this.active && !this.admitted) {
      this.admitted = true;
      this.stopObserving?.();
      this.stopObserving = undefined;
      this.refreshImage();
    }
  };
  // Resource updates stay in this part; row ResizeObserver owns layout changes.
  private readonly refreshImage = () => {
    if (this.active && this.image) {
      this.notify();
    }
  };
  private readonly onSettled = (event: Event) => {
    // A removed IMG may finish after denial; it no longer owns displayed pixels.
    const element = event.currentTarget;
    if (
      !this.active ||
      element !== this.previewElement ||
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
        this.failImage();
      } else {
        this.releaseRetainedImage();
      }
    } else if (
      event.type === "error" &&
      !this.managed &&
      this.image?.url &&
      !isLocalAssistantAttachmentSource(this.image.url) &&
      !isInlineImageSource(this.image.url)
    ) {
      this.failImage();
    }
  };

  render(image: ImageBlock, options: ImageRenderOptions | undefined) {
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
        this.previewElement = undefined;
        this.admitted = false;
        this.presentationKey = Symbol("image-presentation");
      }
      releaseChatMediaResourceSubscriber(this.refreshImage);
    }
    this.image = image;
    this.options = options;
    if (!this.active) {
      this.releaseRetainedImage();
      releaseChatMediaResourceSubscriber(this.refreshImage);
      return this.renderImagePlaceholder(image);
    }
    // A warm preview needs no network admission. Native images retain their
    // decoded node only within the existing metadata cache and ticket lifetime.
    if (!this.admitted) {
      if (this.managed) {
        this.admitted = Boolean(readCachedManagedImageUrl(image.url, options, image.artifactId));
      } else if (image.url && !this.element) {
        this.element = takeRetainedAssistantImage(image.url, options);
        this.previewElement = this.element;
        this.admitted = Boolean(this.element);
      }
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

    // The image component owns its resource subscription. Reparent its stable subscription when the pane
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
      this.previewElement = undefined;
      if (!decodeFailed) {
        this.releaseRetainedImage();
      }
      const reason =
        availability.status === "unavailable"
          ? availability.reason
          : decodeFailed
            ? t("chat.imageLightbox.loadFailed")
            : undefined;
      return this.present(
        this.renderImagePlaceholder(image, reason, {
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
        retained.timeout = setTimeout(() => this.failImage(), CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS);
      }
      return this.present(this.renderImageElement(image, displayUrl));
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
      void pending.then(() => {
        if (this.pendingPreview === pending && this.active && this.image) {
          this.pendingPreview = undefined;
          this.notify();
        }
      });
    }
    return this.present(
      resource.value
        ? this.renderImageElement(image, resource.value)
        : this.renderImagePlaceholder(
            image,
            resource.value === null ? t("chat.imageLightbox.loadFailed") : undefined,
          ),
    );
  }

  private renderImageElement(image: ImageBlock, previewUrl: string): ImagePresentation {
    return { image, previewUrl, managed: this.managed };
  }

  renderPreviewElement(image: ImageBlock, url: string, title: string) {
    const element = (this.previewElement ??= document.createElement("img"));
    // Rebind to this presentation when a detached image is adopted by a new row.
    element.addEventListener("load", this.onSettled);
    element.addEventListener("error", this.onSettled);
    element.alt = title;
    element.className = "chat-message-image";
    element.referrerPolicy = "no-referrer";
    for (const name of ["width", "height"] as const) {
      if (image[name] === undefined) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, String(image[name]));
      }
    }
    // Assigning even an unchanged src can restart a no-cache native request.
    if (element.getAttribute("src") !== url) {
      element.setAttribute("src", url);
    }
    return element;
  }

  private renderImagePlaceholder(
    image: ImageBlock,
    reason?: string,
    actions?: Pick<AssistantAttachmentStatusCardProps, "path" | "onAllow" | "onRetry">,
  ): ImagePresentation {
    return {
      image,
      managed: this.managed,
      state: reason === undefined ? "loading" : "unavailable",
      reason,
      actions: {
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
        ...actions,
      },
    };
  }

  private releaseRetainedImage() {
    const retained = this.retained;
    this.retained = undefined;
    if (retained?.status === "retaining") {
      clearTimeout(retained.timeout);
    }
  }

  private failImage() {
    this.releaseRetainedImage();
    this.retained = { status: "unavailable" };
    this.refreshImage();
  }

  private present(value: ImagePresentation): ImagePresentation {
    return { ...value, key: this.presentationKey };
  }

  readonly retireHandoff = () => {
    if (this.retained?.status !== "retaining") {
      return;
    }
    this.releaseRetainedImage();
    this.retained = { status: "unavailable" };
    this.previewElement?.removeEventListener("load", this.onSettled);
    this.previewElement?.removeEventListener("error", this.onSettled);
    this.previewElement?.remove();
    this.previewElement = undefined;
    this.element = undefined;
    releaseChatMediaResourceSubscriber(this.refreshImage);
    this.notify();
  };

  dispose() {
    this.active = false;
    if (this.previewElement) {
      this.previewElement.removeEventListener("load", this.onSettled);
      this.previewElement.removeEventListener("error", this.onSettled);
      // Do not retain the removed row through the image's parent or listeners.
      this.previewElement.remove();
    }
    if (this.element && this.image?.url) {
      retainAssistantImage(this.image.url, this.element, this.options, this.image.fileName);
    }
    this.previewElement = undefined;
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.admitted = false;
    this.releaseRetainedImage();
    this.element = undefined;
    this.pendingPreview = undefined;
    this.presentationKey = Symbol("image-presentation");
    releaseChatMediaResourceSubscriber(this.refreshImage);
  }
}

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

export type MessageImagesProps = {
  images: ImageBlock[];
  options?: ImageRenderOptions;
  previews?: JSX.Element[];
};

export function MessageImages(props: MessageImagesProps): JSX.Element {
  let slots: { image: ImageBlock; key: symbol; options: ImageRenderOptions }[] = [];
  let scope = "";
  let policyKey: string | undefined;
  let canonicalMessageKey: string | undefined;
  let localSubmission = false;
  const projection = createMemo(() => {
    const images = props.images;
    const options = props.options;
    const nextScope = JSON.stringify([
      options?.connectionEpoch,
      options?.authToken?.trim(),
      options?.resourceBasePath,
      options?.sessionKey,
      options?.agentId,
    ]);
    const continuing =
      scope === nextScope &&
      (!localSubmission || options?.localSubmission !== false) &&
      (canonicalMessageKey === options?.canonicalMessageKey ||
        (localSubmission && !canonicalMessageKey));
    const nextLocalSubmission = continuing ? localSubmission : options?.localSubmission === true;
    const adoptingSlots =
      continuing &&
      nextLocalSubmission &&
      images.length === slots.length &&
      slots.every(({ image }) => isInlineImageSource(image.url)) &&
      images.every((image) => image.factIndex !== undefined);
    const previousImages = adoptingSlots
      ? images.toSorted((left, right) => (left.factIndex ?? 0) - (right.factIndex ?? 0))
      : slots.map(({ image }) => image);
    const previousSlots = new Map(
      previousImages.map((image, index) => [image.factIndex, slots[index]?.key]),
    );
    // Publish options with the slot key so retiring images keep their previous policy.
    const imageOptions = { ...options, galleryImages: options?.galleryImages ?? images };
    slots = images.map((image, index) => {
      const slot = slots[index];
      const previous =
        image.factIndex !== undefined
          ? previousSlots.get(image.factIndex)
          : slot?.image.factIndex === undefined
            ? slot?.key
            : undefined;
      const preservePresentation =
        policyKey === options?.policyKey ||
        isInlineImageSource(image.url) ||
        (image.url !== undefined && isCanonicalInboundMediaSource(image.url));
      return {
        image,
        key: (continuing && preservePresentation && previous) || Symbol("image-slot"),
        options: imageOptions,
      };
    });
    scope = nextScope;
    policyKey = options?.policyKey;
    canonicalMessageKey = options?.canonicalMessageKey;
    localSubmission =
      nextLocalSubmission &&
      !(options?.canonicalMessageKey && images.every((image) => image.factIndex !== undefined));
    return slots;
  });
  const count = () => props.images.length + (props.previews?.length ?? 0);
  return (
    <Show when={count()}>
      <div
        class={[
          "chat-message-images",
          {
            "chat-message-images--single": count() === 1,
            "chat-message-images--gallery": count() !== 1,
            "chat-message-images--two-column": count() === 2 || count() === 4,
            "chat-message-images--five": count() === 5,
          },
        ]}
      >
        <For each={projection()} keyed={(slot) => slot.key}>
          {(slot) => <MessageImage image={slot().image} options={slot().options} />}
        </For>
        {props.previews}
      </div>
    </Show>
  );
}

type MessageImageProps = { image: ImageBlock; options: ImageRenderOptions };

function MessageImage(props: MessageImageProps): JSX.Element {
  const presented = useContext(SolidContentPresentation);
  // Parked Lit roots release active image subscriptions.
  return (
    <Show when={presented()}>
      <MessageImageContent image={props.image} options={props.options} />
    </Show>
  );
}

function MessageImageContent(props: MessageImageProps): JSX.Element {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const presentation = new MessageImagePresentation(() => setRevision((value) => value + 1));
  const disconnect = useContext(TranscriptMediaDisconnect);
  disconnect?.add(presentation.retireHandoff);
  const model = createMemo(() => {
    revision();
    return presentation.render(props.image, props.options);
  });
  onCleanup(() => {
    disconnect?.delete(presentation.retireHandoff);
    presentation.dispose();
  });
  return (
    <Show when={model().key} keyed>
      {(_key) => <ImageFrame model={model()} presentation={presentation} options={props.options} />}
    </Show>
  );
}

function ImageFrame(props: {
  model: ImagePresentation;
  presentation: MessageImagePresentation;
  options: ImageRenderOptions;
}): JSX.Element {
  const image = () => props.model.image;
  const title = () => imageTitle(image());
  const compact = () => props.model.state === "unavailable";
  const pending = () => props.model.state === "loading";
  const sized = () =>
    Number.isFinite(image().width) &&
    (image().width ?? 0) > 0 &&
    Number.isFinite(image().height) &&
    (image().height ?? 0) > 0;
  const dimensions = () => {
    const ratio = sized() ? image().width! / image().height! : 3 / 2;
    const width = sized()
      ? image().width! < MIN_CHAT_IMAGE_PREVIEW_WIDTH
        ? MIN_CHAT_IMAGE_PREVIEW_WIDTH
        : Math.min(image().width!, 400, 360 * ratio)
      : 400;
    const actualWidth = compact() ? Math.max(MIN_CHAT_IMAGE_PREVIEW_WIDTH, width) : width;
    return { width: actualWidth, height: Math.min(360, actualWidth / ratio) };
  };
  return (
    <span
      ref={props.presentation.observeFrame}
      class={[
        "chat-image-frame",
        {
          "chat-image-frame--image": sized() || pending() || compact(),
          "chat-image-frame--managed": props.model.managed && !compact(),
          "chat-image-frame--compact": compact(),
        },
      ]}
      style={{
        "--chat-image-width": `${dimensions().width}px`,
        "--chat-image-min-width": `${MIN_CHAT_IMAGE_PREVIEW_WIDTH}px`,
        "--chat-image-ratio": compact() ? "auto" : `${dimensions().width} / ${dimensions().height}`,
      }}
      aria-busy={pending() ? "true" : "false"}
      role={pending() ? "status" : undefined}
      aria-label={pending() ? t("common.loading") : undefined}
    >
      <Show
        when={!compact()}
        fallback={
          <AssistantAttachmentStatusCard
            label={image().fileName ?? image().alt ?? t("chat.imageLightbox.untitled")}
            badge={t("chat.attachments.unavailable")}
            reason={props.model.reason}
            {...props.model.actions}
          />
        }
      >
        <span class="chat-image-surface">
          <button
            type="button"
            class="chat-message-image-button"
            aria-label={t("chat.imageLightbox.open", { title: title() })}
            aria-disabled={props.model.previewUrl ? undefined : "true"}
            onFocus={() => props.presentation.admit()}
            onClick={(event) => {
              event.stopPropagation();
              if (props.model.previewUrl) {
                openMessageImage(image(), props.model.previewUrl, props.options);
              } else {
                props.presentation.admit();
              }
            }}
          >
            <Show
              when={props.model.previewUrl}
              fallback={<span class="chat-image-skeleton skeleton" aria-hidden="true" />}
            >
              {(url) => <>{props.presentation.renderPreviewElement(image(), url(), title())}</>}
            </Show>
          </button>
        </span>
      </Show>
      <Show when={props.model.managed && props.model.previewUrl && !compact()}>
        <LitContent
          value={renderChatImageActions(title(), () =>
            loadManagedImageBlob(image().url, props.options, image().artifactId),
          )}
        />
      </Show>
    </span>
  );
}
