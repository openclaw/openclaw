import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { createEffect, createMemo, createSignal, onCleanup, Show, useContext } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { ImageLightboxHost } from "./image-lightbox-context.ts";
import {
  downloadLightboxImage,
  externalLightboxImageUrl,
  resolveLightboxOriginalUrl,
} from "./image-lightbox-files.ts";
import {
  canSwipeLightboxVideo,
  createImageLightboxGallery,
  exitLightboxVideoFullscreen,
  trapLightboxTabFocus,
} from "./image-lightbox-gallery.ts";
import { panImageWithKeyboard } from "./image-lightbox-keyboard.ts";
import { LightboxAction, LightboxChrome, lightboxImageStyle } from "./image-lightbox-view.tsx";
import type { ImageLightboxProps } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";
import imageLightboxStyles from "./image-lightbox.css?inline";
import "./modal-dialog.ts";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_THRESHOLD_PX = 56;
const SWIPE_AXIS_THRESHOLD_PX = 8;
const SLIDE_DURATION_MS = 180;

export function ImageLightboxContent(props: ImageLightboxProps) {
  const host = useContext(ImageLightboxHost);
  const gallery = createImageLightboxGallery();
  const galleryState = gallery.state;
  const hasGallery = () => galleryState().count > 1;
  const currentImage = () => galleryState().current;
  const [openOriginalUrl, setOpenOriginalUrl] = createSignal("", { ownedWrite: true });
  const [resolvingOriginal, setResolvingOriginal] = createSignal(false, { ownedWrite: true });
  const [scale, setScale] = createSignal(1, { ownedWrite: true });
  const [canZoom, setCanZoom] = createSignal(false, { ownedWrite: true });
  const focusables = new Set<HTMLElement>();
  const focusableRef = () => {
    let element: HTMLElement;
    onCleanup(() => focusables.delete(element));
    return (node: HTMLElement) => focusables.add((element = node));
  };
  let imageElement: HTMLImageElement | undefined;
  let stageElement: HTMLDivElement | undefined;
  let slideElement: HTMLDivElement | undefined;
  let videoElement: HTMLVideoElement | undefined;
  // Show can retain a detached branch; media callbacks only consume its mounted nodes.
  const image = () => (imageElement?.isConnected ? imageElement : undefined);
  const stage = () => (stageElement?.isConnected ? stageElement : undefined);
  const slide = () => (slideElement?.isConnected ? slideElement : undefined);
  const video = () => (videoElement?.isConnected ? videoElement : undefined);
  const direction = () => (getComputedStyle(host).direction === "rtl" ? -1 : 1);
  const motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  let disposed = false;
  let panzoom: PanzoomObject | undefined;
  let panzoomImage: HTMLImageElement | undefined;
  let panzoomStage: HTMLDivElement | undefined;
  let stopPanzoomChange: (() => void) | undefined;
  let originalBlobUrl = "";
  let originalUrlRequest = 0;
  let displayedIndex = 0;
  let displayedSource = "";
  let slideAnimation: Animation | undefined;
  let backdropPointer: { pointerId: number; clientX: number; clientY: number } | undefined;
  let activeSwipe:
    | { pointerId: number; x: number; y: number; offset: number; horizontal: boolean }
    | undefined;
  const touchPointers = new Set<number>();
  let suppressDoubleClick = false;
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
    stopPanzoomChange = listen(target, "panzoomchange", handlePanzoomChange);
  }

  function destroyPanzoom() {
    const previousImage = panzoomImage;
    stopPanzoomChange?.();
    stopPanzoomChange = undefined;
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
      gallery.peek().count > 1 &&
      !gallery.peek().busy &&
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
    swipe.offset = gallery.canMove(delta) ? x : x * 0.2;
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
          gallery.canMove(delta)
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
    if (gallery.peek().count <= 1 || !gallery.canMove(delta)) {
      animateSlide(offset);
      return;
    }
    video()?.pause();
    const changed = await gallery.move(delta);
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
    if (gallery.peek().current?.kind !== "video" || gallery.peek().current?.loadDisplayImage) {
      setOpenOriginalUrl("");
      return;
    }
    const current = gallery.peek().current;
    const source = (
      current?.connectVideo
        ? (video()?.getAttribute("src") ?? "")
        : current?.originalSrc || current?.src || fallbackOriginalSrc || fallbackSrc
    ).trim();
    setOpenOriginalUrl("");
    setResolvingOriginal(true);
    try {
      const prepared = await resolveLightboxOriginalUrl(
        source,
        () => host.isConnected && !disposed && request === originalUrlRequest,
      );
      if (prepared && request === originalUrlRequest && !disposed) {
        originalBlobUrl = prepared.blobUrl ?? "";
        setOpenOriginalUrl(prepared.url);
      }
    } catch {
      // The selected media remains viewable; omit an unusable external link.
    } finally {
      if (request === originalUrlRequest && !disposed) {
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
      gallery.peek().count > 1 &&
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
    trapLightboxTabFocus(event, focusables);
  };

  const downloadCurrentImage = () => {
    const item = gallery.peek().current ?? {
      src: props.src,
      originalSrc: props.originalSrc,
      title: props.imageTitle,
      readOriginalBlob: props.readOriginalBlob,
    };
    return downloadLightboxImage(item.originalSrc || item.src, item.title, item.readOriginalBlob);
  };

  const emitClose = (event?: Event) => {
    if (event?.type === "modal-cancel" && exitLightboxVideoFullscreen(video(), event)) {
      return;
    }
    gallery.stopPlayer();
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
        props.loadDisplayImage,
        props.readOriginalBlob,
        props.connectVideo,
        props.imageWidth,
        props.imageHeight,
        props.mediaKind,
      ] as const,
    { equals: (previous, next) => previous.every((value, index) => Object.is(value, next[index])) },
  );
  // Source identity owns decoded-image leases and the native player, not just display state.
  createEffect(
    () => ({ inputs: galleryInputs(), selected: galleryState(), title: props.imageTitle }),
    ({ inputs, title }, previous) => {
      const [
        src,
        originalSrc,
        items,
        loadDisplayImage,
        readOriginalBlob,
        connectVideo,
        imageWidth,
        imageHeight,
        mediaKind,
      ] = inputs;
      const sourceChanged = previous?.inputs !== inputs;
      if (sourceChanged) {
        cancelSwipe();
        destroyPanzoom();
        setScale(1);
        gallery.reset(items, {
          kind: mediaKind,
          connectVideo,
          src,
          originalSrc,
          // Renaming the image updates the header without restarting its resource owner.
          title,
          width: imageWidth,
          height: imageHeight,
          loadDisplayImage,
          readOriginalBlob,
        });
      }
      if (disposed || !host.isConnected) {
        return;
      }
      const selectionChanged = sourceChanged || displayedIndex !== gallery.peek().index;
      if (selectionChanged) {
        displayedIndex = gallery.peek().index;
        if (!sourceChanged) {
          destroyPanzoom();
          setScale(1);
        }
      }
      gallery.connectPlayer(video());
      const source = video()?.getAttribute("src") ?? gallery.peek().current?.src ?? src;
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
  const stopMotionChange = motionQuery
    ? listen(motionQuery, "change", handleMotionPreferenceChange)
    : undefined;
  onCleanup(() => {
    disposed = true;
    cancelSwipe();
    touchPointers.clear();
    slideAnimation?.cancel();
    stopMotionChange?.();
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
        prop:initialFocus={() =>
          [...focusables].find((element) => element.isConnected && element.autofocus) ?? null
        }
        class="mobile-edge-to-edge viewport-edge-to-edge"
        label={
          props.mediaKind === "video"
            ? t("chat.mediaPlayer.videoPreview", { title: title() })
            : t("chat.imageLightbox.label", { title: title() })
        }
        onModal-cancel={emitClose}
        ref={nativeListener("keydown", handleKeydown, true)}
      >
        <LightboxChrome
          focusableRef={focusableRef}
          title={title()}
          originalUrl={openOriginalUrl()}
          externalImageUrl={externalLightboxImageUrl(currentImage() ?? props)}
          resolvingOriginal={hasGallery() && resolvingOriginal()}
          isVideo={props.mediaKind === "video"}
          onDownloadImage={downloadCurrentImage}
          onClose={emitClose}
        >
          <Show when={galleryState().upgrading || galleryState().upgradeFailed}>
            <div class="image-quality-status" role="status" aria-live="polite">
              <span>
                {galleryState().upgrading
                  ? t("chat.imageLightbox.loadingDetail")
                  : t("chat.imageLightbox.detailFailed")}
              </span>
              <Show when={galleryState().upgradeFailed}>
                <button
                  ref={focusableRef()}
                  type="button"
                  class="action"
                  onClick={() => gallery.retryDisplayImage()}
                >
                  {t("common.retry")}
                </button>
              </Show>
            </div>
          </Show>
          <div
            class={[
              "stage",
              {
                "stage--video": props.mediaKind === "video",
                "stage--gallery": props.mediaKind !== "video" && hasGallery(),
              },
            ]}
            ref={[
              (element) => {
                stageElement = element;
              },
              nativeListener("pointerdown", handleStagePointerDown, true),
              nativeListener("wheel", handleWheel, { passive: false }),
            ]}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerCancel}
            onDblClick={handleDoubleClick}
          >
            <Show
              when={props.mediaKind === "video"}
              fallback={
                <div
                  class="slide"
                  ref={(element) => {
                    slideElement = element;
                  }}
                >
                  <img
                    class={["image", { zoomed: scale() > 1 }]}
                    ref={(element) => {
                      imageElement = element;
                    }}
                    style={lightboxImageStyle(currentImage())}
                    src={currentImage()?.src ?? props.src}
                    alt={title()}
                    referrerpolicy="no-referrer"
                    decoding="async"
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    onDragStart={(event) => event.preventDefault()}
                  />
                </div>
              }
            >
              <video
                class="video"
                ref={[
                  (element) => {
                    videoElement = element;
                  },
                  focusableRef(),
                ]}
                onLoadedData={() => gallery.updateVideoStatus("ready")}
                onPlaying={() => gallery.updateVideoStatus("ready")}
                onError={() => gallery.updateVideoStatus("unavailable")}
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
              focusableRef={focusableRef}
              class="navigation previous"
              label={
                props.mediaKind === "video" ? "common.previous" : "chat.imageLightbox.previous"
              }
              disabled={galleryState().busy || galleryState().index === 0}
              action={() => navigate(-1)}
            >
              <Icon name="chevronLeft" />
            </LightboxAction>
            <LightboxAction
              focusableRef={focusableRef}
              class="navigation next"
              label={props.mediaKind === "video" ? "common.next" : "chat.imageLightbox.next"}
              disabled={galleryState().busy || galleryState().index + 1 >= galleryState().count}
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
                <button ref={focusableRef()} class="action" onClick={() => gallery.retryVideo()}>
                  {t("common.retry")}
                </button>
              </Show>
            </p>
          </Show>
          <Show when={props.mediaKind === "image"}>
            <div class="zoom-controls">
              <LightboxAction
                focusableRef={focusableRef}
                class="zoom-control"
                label="chat.imageLightbox.zoomOut"
                disabled={!canZoom() || scale() <= 1}
                action={zoomOut}
              >
                −
              </LightboxAction>
              <LightboxAction
                focusableRef={focusableRef}
                class="zoom-control zoom-level"
                label="chat.imageLightbox.resetZoom"
                disabled={!canZoom() || scale() === 1}
                action={resetZoom}
              >
                {Math.round(scale() * 100)}%
              </LightboxAction>
              <LightboxAction
                focusableRef={focusableRef}
                class="zoom-control"
                label="chat.imageLightbox.zoomIn"
                disabled={!canZoom() || scale() >= MAX_SCALE}
                action={zoomIn}
              >
                +
              </LightboxAction>
            </div>
          </Show>
        </LightboxChrome>
      </openclaw-modal-dialog>
    </>
  );
}
