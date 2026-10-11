import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { BROWSER_IMAGE_MIME_TYPES } from "../../../src/shared/browser-image-mime-types.js";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import {
  canSwipeLightboxVideo,
  ImageLightboxGalleryController,
  exitLightboxVideoFullscreen,
  trapLightboxTabFocus,
} from "./image-lightbox-gallery.ts";
import { panImageWithKeyboard } from "./image-lightbox-keyboard.ts";
import { LightboxAction, LightboxHeader, lightboxImageStyle } from "./image-lightbox-view.tsx";
import type { ImageLightboxGallery, ImageLightboxItem } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";
import imageLightboxStyles from "./image-lightbox.css?inline";
import "./modal-dialog.ts";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_THRESHOLD_PX = 56;
const SWIPE_AXIS_THRESHOLD_PX = 8;
const SLIDE_DURATION_MS = 180;

type ImageLightboxProps = {
  connectVideo?: ImageLightboxItem["connectVideo"];
  gallery?: ImageLightboxGallery;
  loadFullResolution?: ImageLightboxItem["loadFullResolution"];
  mediaKind: "image" | "video";
  src: string;
  originalSrc: string;
  imageTitle: string;
  imageWidth?: number;
  imageHeight?: number;
};

type ImageLightboxElement = SolidBridgeElement<ImageLightboxProps>;

function mimeTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function dataUrlMimeType(source: string): string | undefined {
  const mediaType = /^data:([^,]*)/i.exec(source)?.[1];
  return mediaType === undefined ? undefined : mimeTypeEssence(mediaType);
}

function ImageLightboxContent(props: ImageLightboxProps, host: ImageLightboxElement) {
  // The view lifecycle synchronously publishes controller and media-state changes.
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const controller = new ImageLightboxGalleryController(() => setRevision((value) => value + 1));
  const galleryState = () => {
    revision();
    return controller;
  };
  const hasGallery = () => galleryState().count > 1;
  const currentImage = () => galleryState().current;
  const [openOriginalUrl, setOpenOriginalUrl] = createSignal("", { ownedWrite: true });
  const [resolvingOriginal, setResolvingOriginal] = createSignal(false, { ownedWrite: true });
  const [scale, setScale] = createSignal(1, { ownedWrite: true });
  const [canZoom, setCanZoom] = createSignal(false, { ownedWrite: true });
  const image = () => host.querySelector<HTMLImageElement>(".image") ?? undefined;
  const stage = () => host.querySelector<HTMLDivElement>(".stage") ?? undefined;
  const slide = () => host.querySelector<HTMLDivElement>(".slide") ?? undefined;
  const video = () => host.querySelector<HTMLVideoElement>(".video") ?? undefined;
  const direction = () => (getComputedStyle(host).direction === "rtl" ? -1 : 1);
  const motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  let disposed = false;
  let panzoom: PanzoomObject | undefined;
  let panzoomImage: HTMLImageElement | undefined;
  let panzoomStage: HTMLDivElement | undefined;
  let originalBlobUrl = "";
  let originalUrlRequest = 0;
  let resetVersion = 0;
  let displayedResetVersion = -1;
  let displayedIndex = 0;
  let displayedSource = "";
  let slideAnimation: Animation | undefined;
  let backdropPointer: { pointerId: number; clientX: number; clientY: number } | undefined;
  let activeSwipe:
    | { pointerId: number; x: number; y: number; offset: number; horizontal: boolean }
    | undefined;
  const touchPointers = new Set<number>();
  let suppressDoubleClick = false;
  let dialogElement: HTMLElement | undefined;
  let stageElement: HTMLDivElement | undefined;
  const handleImageLoad = (event: Event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLImageElement && target === image()) {
      initializePanzoom(target);
    }
  };

  const handleImageError = (event: Event) => {
    if (event.currentTarget !== image()) {
      return;
    }
    destroyPanzoom();
    setScale(1);
  };

  function initializePanzoom(target: HTMLImageElement) {
    const currentStage = stage();
    if (
      !host.isConnected ||
      disposed ||
      !target.isConnected ||
      !currentStage ||
      target !== image()
    ) {
      return;
    }
    // A decoded resolution upgrade keeps the current image, pan, and zoom.
    if (target === panzoomImage && currentStage === panzoomStage) {
      return;
    }
    destroyPanzoom();
    panzoomImage = target;
    panzoomStage = currentStage;
    panzoom = Panzoom(target, {
      duration: motionQuery?.matches ? 0 : 200,
      maxScale: MAX_SCALE,
      minScale: 1,
      panOnlyWhenZoomed: true,
    });
    setCanZoom(true);
    target.addEventListener("panzoomchange", handlePanzoomChange);
    currentStage.addEventListener("wheel", handleWheel, { passive: false });
  }

  function destroyPanzoom() {
    const previousImage = panzoomImage;
    previousImage?.removeEventListener("panzoomchange", handlePanzoomChange);
    panzoomStage?.removeEventListener("wheel", handleWheel);
    panzoom?.destroy();
    panzoom?.resetStyle();
    previousImage?.style.removeProperty("transform");
    previousImage?.style.removeProperty("transition");
    panzoom = undefined;
    setCanZoom(false);
    panzoomImage = undefined;
    panzoomStage = undefined;
  }

  const handlePanzoomChange = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const detail: unknown = event.detail;
    if (
      typeof detail !== "object" ||
      detail === null ||
      !("scale" in detail) ||
      typeof detail.scale !== "number"
    ) {
      return;
    }
    setScale(detail.scale);
  };

  const handleWheel = (event: WheelEvent) => {
    if (!panzoom) {
      return;
    }
    event.preventDefault();
    panzoom.zoomWithWheel(event);
  };

  const handleDoubleClick = (event: MouseEvent) => {
    if (!panzoom || suppressDoubleClick) {
      return;
    }
    event.preventDefault();
    if (scale() > 1) {
      resetZoom();
      return;
    }
    panzoom?.zoomToPoint(DOUBLE_TAP_SCALE, event);
  };

  const handleStagePointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      touchPointers.add(event.pointerId);
      if (touchPointers.size > 1) {
        cancelSwipe();
        backdropPointer = undefined;
        return;
      }
    }
    suppressDoubleClick = false;
    const target = event.currentTarget;
    if (event.button !== 0 || !event.isPrimary || !(target instanceof HTMLElement)) {
      backdropPointer = undefined;
      return;
    }
    const background = event.target === target || event.target === slide();
    backdropPointer = background
      ? { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
      : undefined;
    if (
      event.pointerType === "touch" &&
      controller.count > 1 &&
      !controller.busy &&
      scale() <= 1 &&
      (props.mediaKind !== "video" || canSwipeLightboxVideo(video(), event))
    ) {
      slideAnimation?.cancel();
      activeSwipe = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offset: 0,
        horizontal: false,
      };
      if (props.mediaKind !== "video") {
        target.setPointerCapture(event.pointerId);
      }
    } else if (background) {
      target.setPointerCapture?.(event.pointerId);
    }
  };

  const handleStagePointerMove = (event: PointerEvent) => {
    const swipe = activeSwipe;
    if (!swipe || swipe.pointerId !== event.pointerId) {
      return;
    }
    if (scale() > 1 || touchPointers.size !== 1) {
      cancelSwipe();
      return;
    }
    const x = event.clientX - swipe.x;
    const y = event.clientY - swipe.y;
    if (!swipe.horizontal) {
      if (Math.max(Math.abs(x), Math.abs(y)) < SWIPE_AXIS_THRESHOLD_PX) {
        return;
      }
      backdropPointer = undefined;
      suppressDoubleClick = true;
      if (Math.abs(y) >= Math.abs(x)) {
        cancelSwipe();
        return;
      }
      swipe.horizontal = true;
      stage()?.setPointerCapture(event.pointerId);
    }
    const delta = x * direction() < 0 ? 1 : -1;
    swipe.offset = controller.canMove(delta) ? x : x * 0.2;
    const currentSlide = slide();
    if (currentSlide) {
      currentSlide.style.transform = `translateX(${swipe.offset}px)`;
    }
  };

  const handleStagePointerUp = (event: PointerEvent) => {
    touchPointers.delete(event.pointerId);
    const swipe = activeSwipe;
    if (swipe?.pointerId === event.pointerId) {
      activeSwipe = undefined;
      if (swipe.horizontal) {
        backdropPointer = undefined;
        const delta = swipe.offset * direction() < 0 ? 1 : -1;
        if (
          Math.abs(swipe.offset) >= SWIPE_THRESHOLD_PX &&
          scale() <= 1 &&
          controller.canMove(delta)
        ) {
          void navigate(delta, swipe.offset);
        } else {
          animateSlide(swipe.offset);
        }
        return;
      }
    }
    const pointer = backdropPointer;
    backdropPointer = undefined;
    const root = host.getRootNode();
    const hitTestRoot = root instanceof ShadowRoot ? root : host.ownerDocument;
    const releaseTarget = hitTestRoot.elementFromPoint?.(event.clientX, event.clientY);
    const shouldClose =
      event.button === 0 &&
      event.isPrimary &&
      pointer?.pointerId === event.pointerId &&
      (releaseTarget === stage() || releaseTarget === slide()) &&
      Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) <= 4;
    if (shouldClose) {
      emitClose();
    }
  };

  const handleStagePointerCancel = (event: PointerEvent) => {
    touchPointers.delete(event.pointerId);
    backdropPointer = undefined;
    cancelSwipe();
  };

  function cancelSwipe() {
    const offset = activeSwipe?.offset ?? 0;
    activeSwipe = undefined;
    animateSlide(offset);
  }

  function animateSlide(offset: number) {
    slideAnimation?.cancel();
    const currentSlide = slide();
    if (!currentSlide) {
      return;
    }
    currentSlide.style.removeProperty("transform");
    if (offset && !motionQuery?.matches && host.isConnected && !disposed) {
      slideAnimation = currentSlide.animate(
        [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
        { duration: SLIDE_DURATION_MS, easing: "ease-out" },
      );
    }
  }

  async function navigate(delta: number, offset = 0) {
    if (controller.count <= 1 || !controller.canMove(delta)) {
      animateSlide(offset);
      return;
    }
    video()?.pause();
    const changed = await controller.move(delta);
    if (!host.isConnected || disposed) {
      return;
    }
    await host.updateComplete;
    animateSlide(changed ? delta * direction() * (stage()?.clientWidth ?? 0) : offset);
  }

  const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
    panzoom?.setOptions({ duration: event.matches ? 0 : 200 });
    if (event.matches) {
      slideAnimation?.cancel();
    }
  };

  const zoomIn = () => panzoom?.zoomIn();
  const zoomOut = () => panzoom?.zoomOut();
  const resetZoom = () => panzoom?.reset({ animate: false });

  function revokeOriginalBlobUrl() {
    if (!originalBlobUrl) {
      return;
    }
    URL.revokeObjectURL(originalBlobUrl);
    originalBlobUrl = "";
  }

  async function resolveOriginalUrl(fallbackSrc: string, fallbackOriginalSrc: string) {
    const request = ++originalUrlRequest;
    revokeOriginalBlobUrl();
    setResolvingOriginal(false);
    if (controller.current?.loadFullResolution) {
      setOpenOriginalUrl("");
      return;
    }
    const current = controller.current;
    const source = (
      current?.connectVideo
        ? (video()?.getAttribute("src") ?? "")
        : current?.originalSrc || current?.src || fallbackOriginalSrc || fallbackSrc
    ).trim();
    if (!source) {
      setOpenOriginalUrl("");
      return;
    }
    const sourcePrefix = source.slice(0, 5).toLowerCase();
    const isDataUrl = sourcePrefix === "data:";
    const isBlobUrl = sourcePrefix === "blob:";
    if (!isDataUrl && !isBlobUrl) {
      setOpenOriginalUrl(source);
      return;
    }
    setOpenOriginalUrl("");
    const sourceType = isDataUrl ? dataUrlMimeType(source) : undefined;
    // Reject active data formats before fetching. Incoming blob URLs still need
    // their fetched MIME checked because top-level blobs inherit the app origin.
    if (isDataUrl && (!sourceType || !BROWSER_IMAGE_MIME_TYPES.has(sourceType))) {
      return;
    }
    setResolvingOriginal(true);
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      if (
        !host.isConnected ||
        disposed ||
        request !== originalUrlRequest ||
        !BROWSER_IMAGE_MIME_TYPES.has(mimeTypeEssence(blob.type))
      ) {
        return;
      }
      if (isBlobUrl) {
        setOpenOriginalUrl(source);
        return;
      }
      originalBlobUrl = URL.createObjectURL(blob);
      setOpenOriginalUrl(originalBlobUrl);
    } catch {
      // The image remains viewable inline; omit an unusable original-link action.
    } finally {
      if (request === originalUrlRequest) {
        setResolvingOriginal(false);
      }
    }
  }

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && exitLightboxVideoFullscreen(video(), event)) {
      return;
    }
    if (panImageWithKeyboard(event, panzoom)) {
      return;
    }
    const nativePlayer = event.composedPath().some((target) => target instanceof HTMLVideoElement);
    if (
      controller.count > 1 &&
      !nativePlayer &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void navigate((event.key === "ArrowRight" ? 1 : -1) * direction());
      return;
    }
    const zoom =
      event.key === "+" || event.key === "="
        ? zoomIn
        : event.key === "-"
          ? zoomOut
          : event.key === "0"
            ? resetZoom
            : undefined;
    if (panzoom && zoom) {
      event.preventDefault();
      zoom();
      return;
    }
    trapLightboxTabFocus(event, host.querySelectorAll<HTMLElement>(".action, video[controls]"));
  };

  const emitClose = (event?: Event) => {
    if (event?.type === "modal-cancel" && exitLightboxVideoFullscreen(video(), event)) {
      return;
    }
    controller.stopPlayer();
    host.dispatchEvent(
      new CustomEvent("image-lightbox-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
  const galleryInputs = createMemo(
    () =>
      [
        props.src,
        props.originalSrc,
        props.gallery,
        props.loadFullResolution,
        props.connectVideo,
        props.imageWidth,
        props.imageHeight,
        props.mediaKind,
      ] as const,
    { equals: (previous, next) => previous.every((value, index) => Object.is(value, next[index])) },
  );
  createRenderEffect(
    galleryInputs,
    ([
      src,
      originalSrc,
      gallery,
      loadFullResolution,
      connectVideo,
      imageWidth,
      imageHeight,
      mediaKind,
    ]) => {
      cancelSwipe();
      destroyPanzoom();
      setScale(1);
      controller.reset(gallery, {
        kind: mediaKind,
        connectVideo,
        src,
        originalSrc,
        // Renaming the image updates the header without restarting its resource owner.
        title: untrack(() => props.imageTitle),
        width: imageWidth,
        height: imageHeight,
        loadFullResolution,
      });
      resetVersion += 1;
      setRevision((value) => value + 1);
    },
  );
  createEffect(
    () => ({ revision: revision(), src: props.src, originalSrc: props.originalSrc }),
    ({ src, originalSrc }) => {
      if (disposed || !host.isConnected) {
        return;
      }
      const selectionChanged =
        displayedResetVersion !== resetVersion || displayedIndex !== controller.index;
      if (selectionChanged) {
        displayedResetVersion = resetVersion;
        displayedIndex = controller.index;
        destroyPanzoom();
        setScale(1);
      }
      controller.connectPlayer(video());
      const source = video()?.getAttribute("src") ?? controller.current?.src ?? src;
      if (selectionChanged || displayedSource !== source) {
        displayedSource = source;
        void resolveOriginalUrl(src, originalSrc);
        const current = image();
        if (current?.complete && current.naturalWidth > 0) {
          initializePanzoom(current);
        }
      }
    },
  );
  motionQuery?.addEventListener("change", handleMotionPreferenceChange);
  onCleanup(() => {
    disposed = true;
    controller.dispose();
    cancelSwipe();
    touchPointers.clear();
    slideAnimation?.cancel();
    motionQuery?.removeEventListener("change", handleMotionPreferenceChange);
    dialogElement?.removeEventListener("keydown", handleKeydown, true);
    stageElement?.removeEventListener("pointerdown", handleStagePointerDown, true);
    destroyPanzoom();
    originalUrlRequest += 1;
    revokeOriginalBlobUrl();
  });

  const title = () =>
    (hasGallery() ? (currentImage()?.title ?? props.imageTitle) : props.imageTitle).trim() ||
    t("chat.imageLightbox.untitled");
  return (
    <>
      <style>{imageLightboxStyles}</style>
      <openclaw-modal-dialog
        class="mobile-edge-to-edge viewport-edge-to-edge"
        label={
          props.mediaKind === "video"
            ? t("chat.mediaPlayer.videoPreview", { title: title() })
            : t("chat.imageLightbox.label", { title: title() })
        }
        onModal-cancel={emitClose}
        ref={(element) => {
          dialogElement = element;
          element.addEventListener("keydown", handleKeydown, true);
        }}
      >
        <section class="lightbox">
          <LightboxHeader
            title={title()}
            originalUrl={openOriginalUrl()}
            resolvingOriginal={hasGallery() && resolvingOriginal()}
            isVideo={props.mediaKind === "video"}
            onClose={emitClose}
          />
          <div
            class={
              props.mediaKind === "video"
                ? "stage stage--video"
                : hasGallery()
                  ? "stage stage--gallery"
                  : "stage"
            }
            ref={(element) => {
              stageElement = element;
              element.addEventListener("pointerdown", handleStagePointerDown, true);
            }}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerCancel}
            onDblClick={handleDoubleClick}
          >
            <Show
              when={props.mediaKind === "video"}
              fallback={
                <div class="slide">
                  <img
                    class={scale() > 1 ? "image zoomed" : "image"}
                    style={lightboxImageStyle(currentImage())}
                    src={currentImage()?.src ?? props.src}
                    alt={title()}
                    referrerpolicy="no-referrer"
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    onDragStart={(event) => event.preventDefault()}
                  />
                </div>
              }
            >
              <video
                class="video"
                onLoadedData={() => controller.updateVideoStatus("ready")}
                onPlaying={() => controller.updateVideoStatus("ready")}
                onError={() => controller.updateVideoStatus("unavailable")}
                aria-label={title()}
                controls
                autoplay
                playsinline
                tabindex="0"
              />
            </Show>
          </div>
          <Show when={hasGallery()}>
            <LightboxAction
              class="navigation previous"
              label={
                props.mediaKind === "video" ? "common.previous" : "chat.imageLightbox.previous"
              }
              disabled={!galleryState().canMove(-1) || galleryState().busy}
              action={() => navigate(-1)}
            >
              <Icon name="chevronLeft" />
            </LightboxAction>
            <LightboxAction
              class="navigation next"
              label={props.mediaKind === "video" ? "common.next" : "chat.imageLightbox.next"}
              disabled={!galleryState().canMove(1) || galleryState().busy}
              action={() => navigate(1)}
            >
              <Icon name="chevronRight" />
            </LightboxAction>
            <p
              class="gallery-counter"
              dir="ltr"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {t("chat.imageLightbox.position", {
                current: String(galleryState().index + 1),
                total: String(galleryState().count),
              })}
            </p>
            <Show when={galleryState().failed}>
              <p class="gallery-error" role="alert">
                {t("chat.imageLightbox.loadFailed")}
              </p>
            </Show>
          </Show>
          <Show when={props.mediaKind === "video" && galleryState().videoStatus !== "ready"}>
            <p class="gallery-error" role="status">
              {galleryState().videoStatus === "preparing"
                ? t("chat.mediaPlayer.preparing")
                : t("chat.attachments.previewUnavailable")}
              <Show
                when={galleryState().videoStatus === "unavailable" && galleryState().videoRetryable}
              >
                <button class="action" onClick={() => controller.retryVideo()}>
                  {t("common.retry")}
                </button>
              </Show>
            </p>
          </Show>
          <Show when={props.mediaKind === "image"}>
            <div class="zoom-controls">
              <LightboxAction
                class="zoom-control"
                label="chat.imageLightbox.zoomOut"
                disabled={!canZoom() || scale() <= 1}
                action={zoomOut}
              >
                −
              </LightboxAction>
              <LightboxAction
                class="zoom-control zoom-level"
                label="chat.imageLightbox.resetZoom"
                disabled={!canZoom() || scale() === 1}
                action={resetZoom}
              >
                {Math.round(scale() * 100)}%
              </LightboxAction>
              <LightboxAction
                class="zoom-control"
                label="chat.imageLightbox.zoomIn"
                disabled={!canZoom() || scale() >= MAX_SCALE}
                action={zoomIn}
              >
                +
              </LightboxAction>
            </div>
          </Show>
        </section>
      </openclaw-modal-dialog>
    </>
  );
}

export const ImageLightbox = defineSolidBridge<ImageLightboxProps>(
  "openclaw-image-lightbox",
  ImageLightboxContent,
  {
    properties: {
      connectVideo: { default: undefined, attribute: false },
      gallery: { default: undefined, attribute: false },
      loadFullResolution: { default: undefined, attribute: false },
      mediaKind: { default: "image" },
      src: { default: "" },
      originalSrc: { default: "" },
      imageTitle: { default: "", attribute: false },
      imageWidth: { default: undefined, attribute: false },
      imageHeight: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": ImageLightboxElement;
  }
}
