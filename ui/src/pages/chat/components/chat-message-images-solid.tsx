import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, onCleanup, refresh, useContext } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { chatImageDisplayKey, isChatThumbnail } from "../../../lib/chat/row-display-facts.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { ImageFrame, type ImagePresentation } from "./chat-image-frame.tsx";
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
import {
  managedImageInlineVariant,
  readCachedManagedImageUrl,
  resolveManagedImageResource,
} from "./chat-message-image-loading.ts";
import { openMessageImage } from "./chat-message-image-open.ts";
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
import type { ImageBlock, ImageRenderOptions, MessageMediaAction } from "./chat-message-media.ts";
import { ChatRowDisplayContext } from "./chat-row-display-context.ts";
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";

registerEnglishCatalog(registerChatComposerEnglish);

registerEnglishCatalog(registerChatMediaEnglish);

type MessageImageProps = { image: ImageBlock; options: ImageRenderOptions };

const CANONICAL_IMAGE_HANDOFF_TIMEOUT_MS = 30_000;

type RetainedInlineImage = {
  status: "retaining";
  previewUrl: string;
  timeout?: ReturnType<typeof setTimeout>;
};

const isInlineImageSource = (source: string | undefined): source is string =>
  source?.startsWith("data:image/") === true || source?.startsWith("blob:") === true;

function createMessageImagePresentation(props: MessageImageProps) {
  const display = useContext(ChatRowDisplayContext);
  let active = true;
  let loadedBlob: Blob | undefined;
  let thumbnail: { blob: Blob; url: string; scope: string } | undefined;
  const displayKey = (image: ImageBlock) => chatImageDisplayKey(image, previewWidth);
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
  const subscribedOptions = (options: ImageRenderOptions | undefined) =>
    options?.mediaOwner !== undefined || options?.onMediaChange !== undefined
      ? { ...options, onMediaChange: refreshImage }
      : options;
  const onSettled = (event: Event) => {
    // A removed IMG may finish after denial; it no longer owns displayed pixels.
    const element = previewElement;
    if (!active || event.currentTarget !== element || !element?.isConnected) {
      return;
    }
    loadedElement = event.type === "load" ? element : undefined;
    const image = currentImage;
    const key = image && displayKey(image);
    const row = display?.();
    if (event.type === "error" && thumbnail && element.getAttribute("src") === thumbnail.url) {
      const saved = key && row?.read()?.facts?.images?.[key];
      if (saved && row && key) {
        const { thumbnail: _thumbnail, ...dimensions } = saved;
        row.write({ images: { ...row.read()?.facts?.images, [key]: dimensions } });
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
    if (loadedElement && image && key && row) {
      const canRetain = managedImageInlineVariant(image) === "thumbnail";
      const record = (bytes = loadedBlob) => {
        const { naturalWidth: width, naturalHeight: height } = element;
        if (width <= 0 || height <= 0) {
          return;
        }
        const previous = row.read()?.facts?.images?.[key];
        const blob = canRetain && isChatThumbnail(bytes) ? bytes : previous?.thumbnail;
        if (
          previous?.width !== width ||
          previous?.height !== height ||
          previous?.thumbnail !== blob
        ) {
          row.write({
            images: {
              ...row.read()?.facts?.images,
              [key]: { width, height, rendition: previewWidth, thumbnail: blob },
            },
          });
        }
      };
      record();
      const source =
        !loadedBlob && image.url && isCanonicalInboundMediaSource(image.url) && canRetain
          ? new URL(element.currentSrc || element.src, location.origin)
          : undefined;
      if (
        source?.origin === location.origin &&
        source.searchParams.get("variant") === "thumbnail"
      ) {
        // A native preview already populated HTTP cache; this read cannot use the network.
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
    if (loadedElement) {
      refreshImage();
    }
  };

  function readPresentation(
    image: ImageBlock,
    options: ImageRenderOptions | undefined,
  ): Omit<ImagePresentation, "image" | "key" | "managed" | "previewSize"> {
    const key = displayKey(image);
    const row = display?.()?.read();
    const saved = key ? row?.facts?.images?.[key] : undefined;
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
    // Recording already displayed pixels must not replace the mounted live image.
    if (
      active &&
      row &&
      saved?.thumbnail &&
      (thumbnail || !previewElement || options?.mediaReadAllowed === false)
    ) {
      if (thumbnail?.blob !== saved.thumbnail || thumbnail?.scope !== row.scope) {
        if (thumbnail) {
          URL.revokeObjectURL(thumbnail.url);
        }
        thumbnail = {
          blob: saved.thumbnail,
          url: URL.createObjectURL(saved.thumbnail),
          scope: row.scope,
        };
      }
      releaseChatMediaResourceOwner(refreshImage);
      // These bytes were displayed under this snapshot's scope. They authorize no read or action.
      return { previewUrl: thumbnail.url };
    }
    if (!active || (options?.mediaReadAllowed === false && !isInlineImageSource(image.url))) {
      releaseRetainedImage();
      releaseChatMediaResourceOwner(refreshImage);
      return {};
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
      return {};
    }
    admitted = true;
    // A pane owns cancellation; this image alone owns its presentation updates.
    const subscriptionOptions = subscribedOptions(options);
    const observed = subscriptionOptions !== options;
    if (observed) {
      pendingPreview = undefined;
      observeChatMediaResourceSubscriber(options?.mediaOwner, refreshImage);
    } else {
      releaseChatMediaResourceOwner(refreshImage);
    }
    const source = image.url;
    if (source === undefined) {
      return renderManagedImage(image, subscriptionOptions);
    }
    const availability = resolveAssistantAttachmentAvailability(source, subscriptionOptions);
    const decodeFailed = retainedImage?.status === "unavailable";
    const failure = availability.status === "unavailable" ? availability : undefined;
    // Tickets authorize new reads, not already decoded pixels. Only this
    // mounted image can survive an unconfirmed renewal; denial still clears it.
    const unconfirmed = availability.status === "checking" || failure?.unconfirmed;
    const displayUrl =
      availability.status === "available"
        ? buildAssistantAttachmentUrl(
            source,
            options?.resourceBasePath,
            availability.mediaTicket,
            options,
            image.fileName,
            managed ? undefined : "thumbnail",
            previewWidth,
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
      const reason = failure
        ? failure.reason
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
      return {
        reason,
        actions: {
          path: isLocalAssistantAttachmentSource(source) ? source : undefined,
          onAllow: !decodeFailed && failure?.canAllow ? () => retryAvailability(true) : undefined,
          onRetry: decodeFailed
            ? () => {
                releaseRetainedImage();
                refreshImage();
              }
            : failure?.recoverable
              ? () => retryAvailability()
              : undefined,
        },
        originalUnavailable: Boolean(failure && !failure.unconfirmed),
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
      return { previewUrl: displayUrl };
    }
    return renderManagedImage(image, subscriptionOptions, displayUrl);
  }

  function renderManagedImage(
    image: ImageBlock,
    subscriptionOptions: ImageRenderOptions | undefined,
    source = image.url,
    retry = false,
  ) {
    const resource = resolveManagedImageResource(
      source,
      subscriptionOptions,
      image.artifactId,
      managedImageInlineVariant(image),
      retry,
      previewWidth,
    );
    loadedBlob = readManagedImageBlob(resource.cacheKey);
    // Standalone previews settle once without opting into a pane's automatic retries.
    if (!subscriptionOptions?.onMediaChange && resource.pending) {
      observeStandalonePreview(resource.pending);
    }
    return {
      previewUrl: resource.value || undefined,
      reason: resource.value === null ? t("chat.imageLightbox.loadFailed") : undefined,
    };
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
    const key = image.width && image.height ? undefined : displayKey(image);
    return (key ? display?.()?.read()?.facts?.images?.[key] : undefined) ?? image;
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
      const listeners = [listen(element, "load", onSettled), listen(element, "error", onSettled)];
      previewEvents = {
        element,
        stop: () => listeners.forEach((stop) => stop()),
      };
    }
    const attribute = (name: string, value: string | number | undefined) => {
      if (value === undefined) {
        element.removeAttribute(name);
      } else if (element.getAttribute(name) !== String(value)) {
        element.setAttribute(name, String(value));
      }
    };
    attribute("alt", title);
    // Local bytes and a mounted handoff must not wait for another viewport admission.
    attribute(
      "loading",
      isInlineImageSource(url) || retainedImage?.status === "retaining" ? "eager" : "lazy",
    );
    attribute(
      "srcset",
      url.includes("&variant=thumbnail&width=")
        ? `${url.replace(/&width=\d+/u, "&width=480")} 1x, ${url.replace(/&width=\d+/u, "&width=960")} 2x`
        : undefined,
    );
    const dimensions = knownImageSize(image);
    attribute("width", dimensions.width);
    attribute("height", dimensions.height);
    // Assigning even an unchanged src can restart a no-cache native request.
    attribute("src", url);
    return element;
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
      reportAssistantImageFailure(currentImage.url, subscribedOptions(currentOptions));
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

  const model = createMemo<ImagePresentation>(() => {
    const image = props.image;
    const view = readPresentation(image, props.options);
    const placeholder: Pick<ImagePresentation, "state" | "actions"> | undefined = view.previewUrl
      ? undefined
      : {
          state: view.reason === undefined ? "loading" : "unavailable",
          actions: {
            onRetry:
              managed && currentOptions?.mediaReadAllowed !== false
                ? () => {
                    renderManagedImage(image, subscribedOptions(currentOptions), image.url, true);
                    refreshImage();
                  }
                : undefined,
            ...view.actions,
          },
        };
    return {
      image,
      managed,
      key: active ? imageKey : undefined,
      previewSize: resolveChatImagePreviewSize(
        knownImageSize(image),
        view.previewUrl && loadedElement
          ? { width: loadedElement.naturalWidth, height: loadedElement.naturalHeight }
          : undefined,
      ),
      ...view,
      ...placeholder,
    };
  });
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

export type MessageImagesProps = {
  images: ImageBlock[];
  options?: ImageRenderOptions;
  previews?: JSX.Element[];
};

export function MessageImages(props: MessageImagesProps): JSX.Element {
  const display = useContext(ChatRowDisplayContext);
  let slots: {
    image: ImageBlock;
    key: symbol;
    options: ImageRenderOptions;
    thumbnail?: Blob;
    displayScope?: string;
    displayKey?: string;
  }[] = [];
  let scope = "";
  let policyKey: string | undefined;
  let canonicalMessageKey: string | undefined;
  let localSubmission = false;
  const projection = createMemo(() => {
    const images = props.images;
    const options = props.options;
    const row = display?.()?.read();
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
      const displayKey = row && chatImageDisplayKey(image, chatImageRenditionWidth("inline"));
      const thumbnail = displayKey ? row?.facts?.images?.[displayKey]?.thumbnail : undefined;
      const sameDisplay =
        thumbnail &&
        slot?.thumbnail === thumbnail &&
        slot.displayScope === row?.scope &&
        slot.displayKey === displayKey;
      const sameScope = !slot?.thumbnail || slot.displayScope === row?.scope;
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
        // Hello changes read authority; identical scoped display bytes keep their native IMG.
        key:
          (sameScope && ((continuing && preservePresentation) || sameDisplay) && previous) ||
          Symbol("image-slot"),
        options: imageOptions,
        thumbnail,
        displayScope: thumbnail ? row?.scope : undefined,
        displayKey: thumbnail ? displayKey : undefined,
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

function MessageImage(props: MessageImageProps): JSX.Element {
  const presented = useContext(ContentPresentation);
  // Parked content releases active image subscriptions.
  return (
    <Show when={presented()}>
      {(_presented) => {
        const view = createMessageImagePresentation(props);
        return (
          <Show when={view.model().key} keyed>
            {(_key) => (
              <ImageFrame model={view.model()} presentation={view} options={props.options} />
            )}
          </Show>
        );
      }}
    </Show>
  );
}

/** Catalogs consume the same admitted image resource and viewer as transcript tiles. */
export function MessageImageAction(
  props: MessageImageProps & { render: (action: () => MessageMediaAction) => JSX.Element },
): JSX.Element {
  // Match the transcript slot's retirement when its scope or policy changes.
  const scope = () =>
    JSON.stringify([
      props.options.sessionKey,
      props.options.agentId,
      props.options.connectionEpoch,
      props.options.resourceBasePath,
      props.options.authToken,
      props.options.policyKey,
      props.options.canonicalMessageKey,
    ]);
  return (
    <Show when={scope()} keyed>
      {(_scope) => {
        const presentation = createMessageImagePresentation(props);
        const action = createMemo<MessageMediaAction>(() => {
          const { actions, state, reason, previewUrl } = presentation.model();
          return {
            ...actions,
            pending: state === "loading",
            reason,
            observeElement: presentation.observeFrame,
            onFocus: state === "unavailable" ? undefined : presentation.admit,
            onOpen: previewUrl
              ? () => openMessageImage(props.image, previewUrl, props.options)
              : undefined,
          };
        });
        return props.render(action);
      }}
    </Show>
  );
}
