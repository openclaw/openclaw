import { createMemo, onCleanup, refresh, useContext } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import {
  chatDisplaySourceKey,
  MAX_CHAT_THUMBNAIL_SIZE,
} from "../../../lib/chat/row-display-facts.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import type { ImagePresentation } from "./chat-image-frame.tsx";
import { resolveChatImagePreviewSize } from "./chat-image-preview-size.ts";
import { chatImageRenditionWidth } from "./chat-image-rendition.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
  reportAssistantImageFailure,
  resolveAssistantAttachmentAvailability,
  retryAssistantAttachmentAvailability,
  retainAssistantImage,
  takeRetainedAssistantImage,
} from "./chat-message-attachment-availability.ts";
import type { AssistantAttachmentStatusCardProps } from "./chat-message-attachment-status-solid.tsx";
import {
  managedImageInlineVariant,
  readCachedManagedImageUrl,
  resolveManagedImageResource,
} from "./chat-message-image-loading.ts";
import {
  buildAssistantAttachmentUrl,
  isCanonicalInboundMediaSource,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
  readManagedImageBlob,
} from "./chat-message-media.ts";
import type { ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";
import { ChatRowDisplayContext } from "./chat-row-display-context.ts";
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";

registerEnglishCatalog(registerChatComposerEnglish);

registerEnglishCatalog(registerChatMediaEnglish);

export type MessageImageProps = { image: ImageBlock; options: ImageRenderOptions };

const CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS = 30_000;

type RetainedInlineImage = {
  status: "retaining";
  previewUrl: string;
  timeout?: ReturnType<typeof setTimeout>;
};

export const isInlineImageSource = (source: string | undefined): source is string =>
  source?.startsWith("data:image/") === true || source?.startsWith("blob:") === true;

export function createMessageImagePresentation(props: MessageImageProps) {
  const display = useContext(ChatRowDisplayContext);
  let active = true;
  let loadedBlob: Blob | undefined;
  let thumbnail: { blob: Blob; url: string } | undefined;
  const displayKey = (image: ImageBlock) => {
    if (!display?.()) {
      return undefined;
    }
    const source = image.url && chatDisplaySourceKey(image.url);
    return image.url && !source
      ? undefined
      : JSON.stringify([image.artifactId ?? null, source ?? null, previewWidth]);
  };
  let currentImage: ImageBlock | undefined;
  let currentOptions: ImageRenderOptions | undefined;
  let loadedElement: HTMLImageElement | undefined;
  let previewElement: HTMLImageElement | undefined;
  let previewEvents: { element: HTMLImageElement; stop: () => void } | undefined;
  let managed = false;
  const previewWidth = chatImageRenditionWidth("inline");
  let pendingPreview: Promise<unknown> | undefined;
  let imageKey = Symbol("image-presentation");
  let retainedImage: RetainedInlineImage | { status: "unavailable" } | undefined;
  let admitted = false;
  let stopObserving: (() => void) | undefined;
  const observeFrame = (element: Element | undefined) => {
    stopObserving?.();
    stopObserving = undefined;
    if (!element || !active || admitted || isInlineImageSource(currentImage?.url)) {
      return;
    }
    const presentationKey = imageKey;
    stopObserving = observeChatAttachmentViewport(element, () => {
      if (presentationKey === imageKey) {
        admit();
      }
    });
  };
  const admit = () => {
    if (active && !admitted) {
      admitted = true;
      stopObserving?.();
      stopObserving = undefined;
      refreshImage();
    }
  };
  // Resource updates stay in this part; row ResizeObserver owns layout changes.
  const refreshImage = () => {
    if (active && currentImage) {
      void refresh(model);
    }
  };
  const onSettled = (event: Event) => {
    // A removed IMG may finish after denial; it no longer owns displayed pixels.
    const element = event.currentTarget;
    if (
      !active ||
      element !== previewElement ||
      !(element instanceof HTMLImageElement) ||
      !element.isConnected
    ) {
      return;
    }
    loadedElement = event.type === "load" ? element : undefined;
    if (event.type === "error" && thumbnail && element.getAttribute("src") === thumbnail.url) {
      const key = currentImage && displayKey(currentImage);
      const row = display?.();
      const saved = key && row?.read()?.images?.[key];
      if (saved && row && key) {
        const { thumbnail: _thumbnail, ...dimensions } = saved;
        row.write({ images: { ...row.read()?.images, [key]: dimensions } });
      }
      URL.revokeObjectURL(thumbnail.url);
      thumbnail = undefined;
      previewElement = undefined;
      refreshImage();
      return;
    }
    if (
      retainedImage?.status === "retaining" &&
      loadedElement?.getAttribute("src") !== retainedImage.previewUrl
    ) {
      if (event.type === "error") {
        failImage();
      } else {
        releaseRetainedImage();
      }
    } else if (
      event.type === "error" &&
      !managed &&
      currentImage?.url &&
      !isInlineImageSource(currentImage.url)
    ) {
      failImage();
    }
    if (loadedElement) {
      const image = currentImage;
      const key = image && displayKey(image);
      const row = display?.();
      const element = loadedElement;
      const record = (bytes = loadedBlob) => {
        if (image && key && row && element.naturalWidth > 0 && element.naturalHeight > 0) {
          const previous = row.read()?.images?.[key];
          const blob =
            managedImageInlineVariant(image) === "thumbnail" &&
            bytes &&
            bytes.size > 0 &&
            bytes.size <= MAX_CHAT_THUMBNAIL_SIZE &&
            /^(?:image\/png|image\/jpeg|image\/webp|image\/avif)$/u.test(bytes.type)
              ? bytes
              : previous?.thumbnail;
          const next = {
            width: element.naturalWidth,
            height: element.naturalHeight,
            rendition: previewWidth,
            thumbnail: blob,
          };
          if (
            previous?.width !== next.width ||
            previous?.height !== next.height ||
            previous?.thumbnail !== blob
          ) {
            row.write({ images: { ...row.read()?.images, [key]: next } });
          }
        }
      };
      record();
      if (
        image?.url &&
        row &&
        !loadedBlob &&
        isCanonicalInboundMediaSource(image.url) &&
        managedImageInlineVariant(image) === "thumbnail"
      ) {
        const source = new URL(element.currentSrc || element.src, location.origin);
        if (
          source.origin === location.origin &&
          source.searchParams.get("variant") === "thumbnail"
        ) {
          // Native inbound previews already populated HTTP cache. This read cannot use the network.
          void fetch(source.href, {
            cache: "only-if-cached",
            mode: "same-origin",
            credentials: "same-origin",
          })
            .then((response) => (response.ok ? response.blob() : undefined))
            .then((bytes) => {
              if (
                bytes &&
                active &&
                previewElement === element &&
                currentImage &&
                displayKey(currentImage) === key
              ) {
                record(bytes);
              }
            })
            .catch(() => {});
        }
      }
      refreshImage();
    }
  };

  function readPresentation(image: ImageBlock, options: ImageRenderOptions | undefined) {
    const key = displayKey(image);
    const saved = key ? display?.()?.read()?.images?.[key] : undefined;
    const previous = currentImage;
    if (previous?.url !== image.url || previous?.artifactId !== image.artifactId) {
      managed = image.url === undefined || isManagedOutgoingMediaSource(image.url);
      pendingPreview = undefined;
      loadedBlob = undefined;
      releaseRetainedImage();
      // The gallery binds the exact submission/slot. Retain only pixels this
      // mounted IMG has loaded, never another pane's cached preview.
      retainedImage =
        image.factIndex !== undefined &&
        previous &&
        isInlineImageSource(previous.url) &&
        previous.artifactId === image.artifactId &&
        image.url !== undefined &&
        isCanonicalInboundMediaSource(image.url) &&
        loadedElement?.getAttribute("src") === previous.url &&
        loadedElement.naturalWidth > 0
          ? { status: "retaining", previewUrl: previous.url }
          : undefined;
      const inlineReplacement =
        options?.localSubmission &&
        previous &&
        isInlineImageSource(previous.url) &&
        isInlineImageSource(image.url);
      if (!retainedImage && !inlineReplacement) {
        loadedElement = undefined;
        previewElement = undefined;
        admitted = false;
        imageKey = Symbol("image-presentation");
      }
      releaseChatMediaResourceOwner(refreshImage);
    }
    currentImage = image;
    currentOptions = options;
    if (active && saved?.thumbnail) {
      if (thumbnail?.blob !== saved.thumbnail) {
        if (thumbnail) {
          URL.revokeObjectURL(thumbnail.url);
        }
        thumbnail = { blob: saved.thumbnail, url: URL.createObjectURL(saved.thumbnail) };
      }
      // These bytes were displayed under this snapshot's scope. They authorize no read or action.
      return renderImageElement(image, thumbnail.url);
    }
    if (!active || (options?.mediaReadAllowed === false && !isInlineImageSource(image.url))) {
      releaseRetainedImage();
      releaseChatMediaResourceOwner(refreshImage);
      return renderImagePlaceholder(image);
    }
    // Reuse decoded images only within the metadata cache and ticket lifetime.
    if (!admitted) {
      if (managed) {
        admitted = Boolean(
          readCachedManagedImageUrl(
            image.url,
            options,
            image.artifactId,
            managedImageInlineVariant(image),
            previewWidth,
          ),
        );
      } else if (image.url && !loadedElement) {
        loadedElement = takeRetainedAssistantImage(image.url, options);
        previewElement = loadedElement;
        admitted = Boolean(loadedElement);
      }
    }
    // Admit network work before resolving metadata, artifact tickets, or blobs.
    // Local bytes and a mounted decoded handoff never wait for the observer.
    if (
      !admitted &&
      !isInlineImageSource(image.url) &&
      !retainedImage &&
      typeof IntersectionObserver === "function"
    ) {
      return renderImagePlaceholder(image);
    }
    admitted = true;
    // A pane owns cancellation; this image alone owns its presentation updates.
    const observed = options?.mediaOwner !== undefined || options?.onMediaChange !== undefined;
    if (observed) {
      pendingPreview = undefined;
      observeChatMediaResourceSubscriber(options?.mediaOwner, refreshImage);
    } else {
      releaseChatMediaResourceOwner(refreshImage);
    }
    const subscriptionOptions = observed ? { ...options, onMediaChange: refreshImage } : options;
    const source = image.url;
    if (source === undefined) {
      return renderManagedImage(image, subscriptionOptions);
    }
    const availability = resolveAssistantAttachmentAvailability(source, subscriptionOptions);
    const decodeFailed = retainedImage?.status === "unavailable";
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
          ? loadedElement?.getAttribute("src")
          : undefined;
    if (!displayUrl || decodeFailed) {
      loadedElement = undefined;
      previewElement = undefined;
      if (!decodeFailed) {
        releaseRetainedImage();
      }
      const reason =
        availability.status === "unavailable"
          ? availability.reason
          : decodeFailed
            ? t("chat.imageLightbox.loadFailed")
            : undefined;
      const retryAvailability = (allowImage = false) => {
        retryAssistantAttachmentAvailability(source, subscriptionOptions, allowImage);
        if (!subscriptionOptions?.onMediaChange) {
          observeStandalonePreview(
            loadAssistantAttachmentAvailability(source, subscriptionOptions),
          );
          refreshImage();
        }
      };
      const placeholder = renderImagePlaceholder(image, reason, {
        path: isLocalAssistantAttachmentSource(source) ? source : undefined,
        onAllow:
          !decodeFailed && availability.status === "unavailable" && availability.canAllow
            ? () => retryAvailability(true)
            : undefined,
        onRetry: decodeFailed
          ? () => {
              releaseRetainedImage();
              refreshImage();
            }
          : availability.status === "unavailable" && availability.recoverable
            ? () => retryAvailability()
            : undefined,
      });
      return {
        ...placeholder,
        originalUnavailable: availability.status === "unavailable" && !availability.unconfirmed,
      };
    }
    if (!managed) {
      const retained = retainedImage;
      if (
        availability.status === "available" &&
        retained?.status === "retaining" &&
        retained.timeout === undefined
      ) {
        // IMG keeps its current decoded request while the new src loads. One
        // native load/error boundary replaces the detached decode preloader.
        retained.timeout = setTimeout(() => failImage(), CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS);
      }
      return renderImageElement(
        image,
        availability.status === "available"
          ? buildAssistantAttachmentUrl(
              source,
              options?.resourceBasePath,
              availability.mediaTicket,
              options,
              image.fileName,
              "thumbnail",
              previewWidth,
            )
          : displayUrl,
      );
    }
    return renderManagedImage(image, subscriptionOptions, displayUrl);
  }

  function renderManagedImage(
    image: ImageBlock,
    subscriptionOptions: ImageRenderOptions | undefined,
    source = image.url,
  ) {
    const resource = resolveManagedImageResource(
      source,
      subscriptionOptions,
      image.artifactId,
      managedImageInlineVariant(image),
      false,
      previewWidth,
    );
    const pending = resource.pending;
    loadedBlob = readManagedImageBlob(resource.cacheKey);
    // Standalone previews settle once without opting into a pane's automatic retries.
    if (!subscriptionOptions?.onMediaChange && pending) {
      observeStandalonePreview(pending);
    }
    return resource.value
      ? renderImageElement(image, resource.value)
      : renderImagePlaceholder(
          image,
          resource.value === null ? t("chat.imageLightbox.loadFailed") : undefined,
        );
  }

  function observeStandalonePreview(pending: Promise<unknown>) {
    if (pendingPreview === pending) {
      return;
    }
    pendingPreview = pending;
    void pending.then(() => {
      if (pendingPreview === pending && active && currentImage) {
        pendingPreview = undefined;
        refreshImage();
      }
    });
  }

  function knownImageSize(image: ImageBlock) {
    // Gallery slots retain wire identity; saved dimensions describe presentation only.
    if (image.width && image.height) {
      return image;
    }
    const key = displayKey(image);
    return (key ? display?.()?.read()?.images?.[key] : undefined) ?? image;
  }

  function renderImageElement(image: ImageBlock, previewUrl: string): ImagePresentation {
    return {
      image,
      previewUrl,
      managed,
      key: imageKey,
      previewSize: resolveChatImagePreviewSize(
        knownImageSize(image),
        loadedElement
          ? { width: loadedElement.naturalWidth, height: loadedElement.naturalHeight }
          : undefined,
      ),
    };
  }

  function renderPreviewElement(image: ImageBlock, url: string, title: string) {
    if (!previewElement) {
      previewElement = document.createElement("img");
      previewElement.className = "chat-message-image";
      previewElement.referrerPolicy = "no-referrer";
      previewElement.decoding = "async";
    }
    const element = previewElement;
    // Decoded images transfer between rows through the media owner. Bind this
    // presentation only while it has custody of that foreign DOM node.
    if (previewEvents?.element !== element) {
      previewEvents?.stop();
      const stopLoad = listen(element, "load", onSettled);
      const stopError = listen(element, "error", onSettled);
      previewEvents = {
        element,
        stop() {
          stopLoad();
          stopError();
        },
      };
    }
    if (element.alt !== title) {
      element.alt = title;
    }
    // Local bytes and a mounted handoff are already admitted. Deferring their
    // replacement decode can introduce blank frames during custody updates.
    const loading =
      isInlineImageSource(url) || retainedImage?.status === "retaining" ? "eager" : "lazy";
    if (element.loading !== loading) {
      element.loading = loading;
    }
    if (url.includes("&variant=thumbnail&width=")) {
      // Signed native requests let the browser choose density and apply its own
      // data-saving policy; authenticated blob requests select a bounded tier above.
      const srcset =
        url.replace(/&width=\d+/u, "&width=480") +
        " 1x, " +
        url.replace(/&width=\d+/u, "&width=960") +
        " 2x";
      if (element.srcset !== srcset) {
        element.srcset = srcset;
      }
    } else {
      element.removeAttribute("srcset");
    }
    const dimensions = knownImageSize(image);
    for (const name of ["width", "height"] as const) {
      if (dimensions[name] === undefined) {
        element.removeAttribute(name);
      } else if (element.getAttribute(name) !== String(dimensions[name])) {
        element.setAttribute(name, String(dimensions[name]));
      }
    }
    // Assigning even an unchanged src can restart a no-cache native request.
    if (element.getAttribute("src") !== url) {
      element.setAttribute("src", url);
    }
    return element;
  }

  function renderImagePlaceholder(
    image: ImageBlock,
    reason?: string,
    actions?: Pick<AssistantAttachmentStatusCardProps, "path" | "onAllow" | "onRetry" | "onOpen">,
  ): ImagePresentation {
    return {
      image,
      managed,
      previewSize: resolveChatImagePreviewSize(knownImageSize(image)),
      key: active ? imageKey : undefined,
      state: reason === undefined ? "loading" : "unavailable",
      reason,
      actions: {
        onRetry:
          managed && currentOptions?.mediaReadAllowed !== false
            ? () => {
                resolveManagedImageResource(
                  image.url,
                  currentOptions?.mediaOwner !== undefined ||
                    currentOptions?.onMediaChange !== undefined
                    ? { ...currentOptions, onMediaChange: refreshImage }
                    : currentOptions,
                  image.artifactId,
                  managedImageInlineVariant(image),
                  true,
                  previewWidth,
                );
                refreshImage();
              }
            : undefined,
        ...actions,
      },
    };
  }

  function releaseRetainedImage() {
    const retained = retainedImage;
    retainedImage = undefined;
    if (retained?.status === "retaining") {
      clearTimeout(retained.timeout);
    }
  }

  function failImage() {
    releaseRetainedImage();
    loadedElement = undefined;
    if (currentImage?.url && isLocalAssistantAttachmentSource(currentImage.url)) {
      reportAssistantImageFailure(
        currentImage.url,
        currentOptions?.mediaOwner !== undefined || currentOptions?.onMediaChange !== undefined
          ? { ...currentOptions, onMediaChange: refreshImage }
          : currentOptions,
      );
    } else {
      retainedImage = { status: "unavailable" };
    }
    refreshImage();
  }

  const retireHandoff = () => {
    if (retainedImage?.status !== "retaining") {
      return;
    }
    releaseRetainedImage();
    retainedImage = { status: "unavailable" };
    previewEvents?.stop();
    previewEvents = undefined;
    previewElement?.remove();
    previewElement = undefined;
    loadedElement = undefined;
    releaseChatMediaResourceOwner(refreshImage);
    // Transcript disposal can run inside a render computation; only invalidation waits.
    queueMicrotask(refreshImage);
  };

  const model = createMemo(() => readPresentation(props.image, props.options));
  const disconnect = useContext(TranscriptMediaDisconnect);
  disconnect?.add(retireHandoff);
  onCleanup(() => {
    disconnect?.delete(retireHandoff);
    active = false;
    if (thumbnail) {
      URL.revokeObjectURL(thumbnail.url);
      thumbnail = undefined;
    }
    previewEvents?.stop();
    previewEvents = undefined;
    // Do not retain the removed row through the image's parent or listeners.
    previewElement?.remove();
    if (loadedElement && currentImage?.url) {
      retainAssistantImage(
        currentImage.url,
        loadedElement,
        currentOptions,
        currentImage.fileName,
        previewWidth,
      );
    }
    previewElement = undefined;
    stopObserving?.();
    stopObserving = undefined;
    admitted = false;
    releaseRetainedImage();
    loadedElement = undefined;
    pendingPreview = undefined;
    imageKey = Symbol("image-presentation");
    releaseChatMediaResourceOwner(refreshImage);
  });
  return { model, observeFrame, admit, renderPreviewElement };
}
