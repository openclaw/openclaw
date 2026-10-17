import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, onCleanup, refresh, untrack, useContext } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { ChatImageActions } from "./chat-image-actions.tsx";
import {
  MIN_CHAT_IMAGE_PREVIEW_WIDTH,
  resolveChatImagePreviewSize,
} from "./chat-image-preview-size.ts";
import { chatImageRenditionWidth } from "./chat-image-rendition.ts";
import {
  isManagedOutgoingMediaSource,
  reportAssistantImageFailure,
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
  managedImageInlineVariant,
  readCachedManagedImageUrl,
  resolveManagedImageResource,
} from "./chat-message-image-loading.ts";
import { imageTitle, openMessageImage, readImageOriginalBlob } from "./chat-message-image-open.ts";
import {
  buildAssistantAttachmentUrl,
  isCanonicalInboundMediaSource,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceSubscriber,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";

const CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS = 30_000;

type RetainedInlineImage = {
  status: "retaining";
  previewUrl: string;
  timeout?: ReturnType<typeof setTimeout>;
};

function isInlineImageSource(source: string | undefined): source is string {
  return source?.startsWith("data:image/") === true || source?.startsWith("blob:") === true;
}

type ImagePresentation = {
  image: ImageBlock;
  key?: symbol;
  managed: boolean;
  previewUrl?: string;
  state?: "loading" | "unavailable";
  actions?: Pick<AssistantAttachmentStatusCardProps, "path" | "onAllow" | "onRetry" | "onOpen">;
  reason?: string;
};

function createMessageImagePresentation(props: MessageImageProps) {
  let active = true;
  let currentImage: ImageBlock | undefined;
  let currentOptions: ImageRenderOptions | undefined;
  let loadedElement: HTMLImageElement | undefined;
  let previewElement: HTMLImageElement | undefined;
  let managed = false;
  const previewWidth = chatImageRenditionWidth("inline");
  let pendingPreview: Promise<string | null> | undefined;
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
  };

  function readPresentation(image: ImageBlock, options: ImageRenderOptions | undefined) {
    const previous = currentImage;
    if (previous?.url !== image.url || previous?.artifactId !== image.artifactId) {
      managed = image.url === undefined || isManagedOutgoingMediaSource(image.url);
      pendingPreview = undefined;
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
      releaseChatMediaResourceSubscriber(refreshImage);
    }
    currentImage = image;
    currentOptions = options;
    if (!active) {
      releaseRetainedImage();
      releaseChatMediaResourceSubscriber(refreshImage);
      return renderImagePlaceholder(image);
    }
    // A warm preview needs no network admission. Native images retain their
    // decoded node only within the existing metadata cache and ticket lifetime.
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
      return present(renderImagePlaceholder(image));
    }
    admitted = true;
    const onRequestUpdate = options?.onRequestUpdate;

    // The image component owns its resource subscription. Reparent its stable subscription when the pane
    // callback changes without discarding its loaded resource.
    if (onRequestUpdate) {
      pendingPreview = undefined;
      observeChatMediaResourceSubscriber(onRequestUpdate, refreshImage);
    } else {
      releaseChatMediaResourceSubscriber(refreshImage);
    }
    const subscriptionOptions = onRequestUpdate
      ? { ...options, onRequestUpdate: refreshImage }
      : options;
    const source = image.url;
    if (source === undefined) {
      return renderManagedImage(image, options, subscriptionOptions);
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
      return present(
        renderImagePlaceholder(image, reason, {
          path: isLocalAssistantAttachmentSource(source) ? source : undefined,
          onAllow:
            !decodeFailed && availability.status === "unavailable" && availability.canAllow
              ? () => retryAssistantAttachmentAvailability(source, subscriptionOptions, true)
              : undefined,
          onRetry: decodeFailed
            ? () => {
                releaseRetainedImage();
                refreshImage();
              }
            : availability.status === "unavailable" && availability.recoverable
              ? () => retryAssistantAttachmentAvailability(source, subscriptionOptions)
              : undefined,
        }),
      );
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
      return present(
        renderImageElement(
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
        ),
      );
    }
    return renderManagedImage(image, options, subscriptionOptions, displayUrl);
  }

  function renderManagedImage(
    image: ImageBlock,
    options: ImageRenderOptions | undefined,
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
    // Standalone renders settle without opting into pane-owned automatic retries.
    if (!options?.onRequestUpdate && pending && pendingPreview !== pending) {
      pendingPreview = pending;
      void pending.then(() => {
        if (pendingPreview === pending && active && currentImage) {
          pendingPreview = undefined;
          void refresh(model);
        }
      });
    }
    return present(
      resource.value
        ? renderImageElement(image, resource.value)
        : renderImagePlaceholder(
            image,
            resource.value === null ? t("chat.imageLightbox.loadFailed") : undefined,
          ),
    );
  }

  function renderImageElement(image: ImageBlock, previewUrl: string): ImagePresentation {
    return { image, previewUrl, managed };
  }

  function renderPreviewElement(image: ImageBlock, url: string, title: string) {
    if (!previewElement) {
      previewElement = document.createElement("img");
      previewElement.className = "chat-message-image";
      previewElement.referrerPolicy = "no-referrer";
      previewElement.decoding = "async";
    }
    const element = previewElement;
    // Rebind to this presentation when a detached image is adopted by a new row.
    element.addEventListener("load", onSettled);
    element.addEventListener("error", onSettled);
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
    for (const name of ["width", "height"] as const) {
      if (image[name] === undefined) {
        element.removeAttribute(name);
      } else if (element.getAttribute(name) !== String(image[name])) {
        element.setAttribute(name, String(image[name]));
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
      state: reason === undefined ? "loading" : "unavailable",
      reason,
      actions: {
        onRetry: managed
          ? () => {
              resolveManagedImageResource(
                image.url,
                currentOptions?.onRequestUpdate
                  ? { ...currentOptions, onRequestUpdate: refreshImage }
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
      reportAssistantImageFailure(currentImage.url, {
        ...currentOptions,
        onRequestUpdate: currentOptions?.onRequestUpdate ? refreshImage : undefined,
      });
    } else {
      retainedImage = { status: "unavailable" };
    }
    refreshImage();
  }

  function present(value: ImagePresentation): ImagePresentation {
    return { ...value, key: imageKey };
  }

  const retireHandoff = () => {
    if (retainedImage?.status !== "retaining") {
      return;
    }
    releaseRetainedImage();
    retainedImage = { status: "unavailable" };
    previewElement?.removeEventListener("load", onSettled);
    previewElement?.removeEventListener("error", onSettled);
    previewElement?.remove();
    previewElement = undefined;
    loadedElement = undefined;
    releaseChatMediaResourceSubscriber(refreshImage);
    // Transcript disposal can run inside a render computation; only invalidation waits.
    queueMicrotask(refreshImage);
  };

  const model = createMemo(() => readPresentation(props.image, props.options));
  const disconnect = useContext(TranscriptMediaDisconnect);
  disconnect?.add(retireHandoff);
  onCleanup(() => {
    disconnect?.delete(retireHandoff);
    active = false;
    if (previewElement) {
      previewElement.removeEventListener("load", onSettled);
      previewElement.removeEventListener("error", onSettled);
      // Do not retain the removed row through the image's parent or listeners.
      previewElement.remove();
    }
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
    releaseChatMediaResourceSubscriber(refreshImage);
  });
  return { model, observeFrame, admit, renderPreviewElement };
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
  const presented = useContext(ContentPresentation);
  // Parked content releases active image subscriptions.
  return (
    <Show when={presented()}>
      <MessageImageContent image={props.image} options={props.options} />
    </Show>
  );
}

function MessageImageContent(props: MessageImageProps): JSX.Element {
  const presentation = createMessageImagePresentation(props);
  const model = presentation.model;
  return (
    <Show when={model().key} keyed>
      {(_key) => <ImageFrame model={model()} presentation={presentation} options={props.options} />}
    </Show>
  );
}

function ImageFrame(props: {
  model: ImagePresentation;
  presentation: ReturnType<typeof createMessageImagePresentation>;
  options: ImageRenderOptions;
}): JSX.Element {
  const image = () => props.model.image;
  const title = () => imageTitle(image());
  const compact = () => props.model.state === "unavailable";
  const pending = () => props.model.state === "loading";
  const loadOriginal = () => readImageOriginalBlob(image(), props.options);
  // Native previews use the viewer’s file controls. Show their inline menu only
  // when a failed preview cannot open that viewer, never over retained pixels.
  const hasFileActions = () =>
    props.model.managed || (compact() && isLocalAssistantAttachmentSource(image().url ?? ""));
  // A mounted preview keeps its initial frame when the upload receipt adds dimensions.
  // Fresh history mounts use those durable dimensions; older facts retain a stable fallback.
  const dimensions = untrack(() => resolveChatImagePreviewSize(props.model.image));
  return (
    <span
      ref={props.presentation.observeFrame}
      class={[
        "chat-image-frame chat-image-frame--image",
        {
          "chat-image-frame--managed": props.model.managed,
          "chat-image-frame--compact": compact(),
        },
      ]}
      style={{
        "--chat-image-width": `${compact() ? Math.max(MIN_CHAT_IMAGE_PREVIEW_WIDTH, dimensions.width) : dimensions.width}px`,
        "--chat-image-ratio": compact() ? "auto" : `${dimensions.width} / ${dimensions.height}`,
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
      <Show when={!pending() && hasFileActions()}>
        <ChatImageActions title={title()} readOriginalBlob={loadOriginal} />
      </Show>
    </span>
  );
}
