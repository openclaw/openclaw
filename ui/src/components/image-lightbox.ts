import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { html, nothing, type PropertyValues } from "lit";
import { property, query, queryAll, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { ImageLightboxGalleryController } from "./image-lightbox-gallery.ts";
import { panImageWithKeyboard } from "./image-lightbox-keyboard.ts";
import { imageLightboxStyles } from "./image-lightbox.styles.ts";
import type { ImageLightboxGallery, ImageLightboxItem } from "./image-lightbox.types.ts";
import "./modal-dialog.ts";

const SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_THRESHOLD_PX = 56;
const SWIPE_AXIS_THRESHOLD_PX = 8;
const SLIDE_DURATION_MS = 180;
const GALLERY_INPUTS = [
  "src",
  "originalSrc",
  "gallery",
  "loadFullResolution",
  "imageWidth",
  "imageHeight",
  "mediaKind",
] as const;

function mimeTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function dataUrlMimeType(source: string): string | undefined {
  const mediaType = /^data:([^,]*)/i.exec(source)?.[1];
  return mediaType === undefined ? undefined : mimeTypeEssence(mediaType);
}

class OpenClawImageLightbox extends OpenClawLitElement {
  @property({ attribute: false }) gallery?: ImageLightboxGallery;
  @property({ attribute: false }) loadFullResolution?: ImageLightboxItem["loadFullResolution"];
  @property() mediaKind: "image" | "video" = "image";
  @property() src = "";
  @property() originalSrc = "";
  @property({ attribute: false }) imageTitle = "";
  @property({ attribute: false }) imageWidth?: number;
  @property({ attribute: false }) imageHeight?: number;
  @query(".slide") private slide?: HTMLDivElement;
  @query(".stage") private stage?: HTMLDivElement;
  @query(".image") private image?: HTMLImageElement;
  @queryAll(".action, video[controls]") private focusables!: NodeListOf<HTMLElement>;
  @state() private openOriginalUrl = "";
  @state() private resolvingOriginal = false;
  @state() private scale = 1;
  @state() private imageReady = false;

  private originalBlobUrl = "";
  private originalUrlRequest = 0;
  private panzoom?: PanzoomObject;
  private panzoomImage?: HTMLImageElement;
  private panzoomStage?: HTMLDivElement;
  private backdropPointer: { pointerId: number; clientX: number; clientY: number } | undefined;
  private motionQuery?: MediaQueryList;
  private readonly galleryController = new ImageLightboxGalleryController(() =>
    this.requestUpdate(),
  );
  private displayedIndex = 0;
  private displayedSource = "";
  private slideAnimation?: Animation;
  private swipe:
    | {
        pointerId: number;
        x: number;
        y: number;
        offset: number;
        horizontal: boolean;
      }
    | undefined;
  private readonly touchPointers = new Set<number>();
  private suppressDoubleClick = false;

  private get currentImage() {
    return this.mediaKind === "image" ? this.galleryController.current : undefined;
  }

  private get hasGallery() {
    return this.mediaKind === "image" && this.galleryController.count > 1;
  }

  private get direction() {
    return getComputedStyle(this).direction === "rtl" ? -1 : 1;
  }

  static override styles = imageLightboxStyles;

  override connectedCallback() {
    super.connectedCallback();
    this.motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.motionQuery?.addEventListener("change", this.handleMotionPreferenceChange);
    if (this.hasUpdated) {
      this.resetGallery();
      this.requestUpdate();
      void this.resolveOriginalUrl();
      void this.updateComplete.then(() => {
        if (!this.isConnected) {
          return;
        }
        const image = this.image;
        if (image?.complete && image.naturalWidth > 0) {
          this.initializePanzoom(image);
        }
      });
    }
  }

  override disconnectedCallback() {
    this.galleryController.dispose();
    this.cancelSwipe();
    this.touchPointers.clear();
    this.slideAnimation?.cancel();
    this.originalUrlRequest += 1;
    this.motionQuery?.removeEventListener("change", this.handleMotionPreferenceChange);
    this.motionQuery = undefined;
    this.destroyPanzoom();
    this.revokeOriginalBlobUrl();
    super.disconnectedCallback();
  }

  private resetGallery() {
    this.galleryController.reset(this.mediaKind === "image" ? this.gallery : undefined, {
      src: this.src,
      originalSrc: this.originalSrc,
      title: this.imageTitle,
      width: this.imageWidth,
      height: this.imageHeight,
      loadFullResolution: this.loadFullResolution,
    });
  }

  protected override willUpdate(changed: PropertyValues) {
    if (!this.isConnected) {
      return;
    }
    if (GALLERY_INPUTS.some((key) => changed.has(key))) {
      this.cancelSwipe();
      this.resetGallery();
    }
  }

  protected override updated(changed: PropertyValues) {
    if (!this.isConnected) {
      return;
    }
    const selectionChanged =
      GALLERY_INPUTS.some((key) => changed.has(key)) ||
      this.displayedIndex !== this.galleryController.index;
    if (selectionChanged) {
      this.displayedIndex = this.galleryController.index;
      this.destroyPanzoom();
      this.scale = 1;
    }
    const source = this.currentImage?.src ?? this.src;
    if (selectionChanged || this.displayedSource !== source) {
      this.displayedSource = source;
      void this.resolveOriginalUrl();
      if (this.image?.complete && this.image.naturalWidth > 0) {
        this.initializePanzoom(this.image);
      }
    }
  }

  override render() {
    const title =
      (this.hasGallery ? (this.currentImage?.title ?? this.imageTitle) : this.imageTitle).trim() ||
      t("chat.imageLightbox.untitled");
    const dialogLabel =
      this.mediaKind === "video"
        ? t("chat.mediaPlayer.videoPreview", { title })
        : t("chat.imageLightbox.label", { title });
    const closeLabel =
      this.mediaKind === "video"
        ? t("chat.mediaPlayer.closeVideoPreview")
        : t("chat.imageLightbox.close");
    const canZoom = this.imageReady && this.panzoom !== undefined;
    const width = this.currentImage?.width;
    const height = this.currentImage?.height;
    const sized = Number.isFinite(width) && width! > 0 && Number.isFinite(height) && height! > 0;
    const imageSize = sized
      ? `width: min(${width}px, 100cqw, calc(100cqh * ${width! / height!}))`
      : nothing;
    return html`
      <openclaw-modal-dialog
        class="mobile-edge-to-edge viewport-edge-to-edge"
        label=${dialogLabel}
        @modal-cancel=${this.emitClose}
        @keydown=${this.handleKeydown}
      >
        <section class="lightbox">
          <header class="header">
            <strong class="title">${title}</strong>
            <div class="actions">
              ${
                this.openOriginalUrl || (this.hasGallery && this.resolvingOriginal)
                  ? html`
                      <a
                        class="action open-original"
                        href=${this.openOriginalUrl || nothing}
                        aria-disabled=${!this.openOriginalUrl}
                        tabindex=${this.openOriginalUrl ? 0 : -1}
                        target="_blank"
                        rel="noreferrer"
                        aria-label=${t("chat.imageLightbox.openOriginal")}
                      >
                        <span class="open-original-label">
                          ${t("chat.imageLightbox.openOriginal")}
                        </span>
                        <span class="open-original-icon" aria-hidden="true">
                          ${icons.externalLink}
                        </span>
                      </a>
                    `
                  : nothing
              }
              <button
                class="action close"
                type="button"
                autofocus
                aria-label=${closeLabel}
                @click=${this.emitClose}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          <div
            class=${this.hasGallery ? "stage stage--gallery" : "stage"}
            @pointerdown=${{ handleEvent: this.handleStagePointerDown, capture: true }}
            @pointermove=${this.handleStagePointerMove}
            @pointerup=${this.handleStagePointerUp}
            @pointercancel=${this.handleStagePointerCancel}
            @dblclick=${this.handleDoubleClick}
          >
            ${
              this.mediaKind === "video"
                ? html`<video
                    class="video"
                    src=${this.src}
                    aria-label=${title}
                    controls
                    autoplay
                    playsinline
                    tabindex="0"
                  ></video>`
                : html`<div class="slide">
                    <img
                      class=${this.scale > 1 ? "image zoomed" : "image"}
                      style=${imageSize}
                      src=${this.currentImage?.src ?? this.src}
                      alt=${title}
                      referrerpolicy="no-referrer"
                      @load=${this.handleImageLoad}
                      @error=${this.handleImageError}
                      @dragstart=${(event: DragEvent) => event.preventDefault()}
                    />
                  </div>`
            }
          </div>
          ${
            this.hasGallery
              ? html`
                  <button
                    class="action navigation previous"
                    type="button"
                    aria-label=${t("chat.imageLightbox.previous")}
                    aria-disabled=${!this.galleryController.canMove(-1) || this.galleryController.busy}
                    @click=${() => this.navigate(-1)}
                  >
                    ${icons.chevronLeft}
                  </button>
                  <button
                    class="action navigation next"
                    type="button"
                    aria-label=${t("chat.imageLightbox.next")}
                    aria-disabled=${!this.galleryController.canMove(1) || this.galleryController.busy}
                    @click=${() => this.navigate(1)}
                  >
                    ${icons.chevronRight}
                  </button>
                  <p
                    class="gallery-counter"
                    dir="ltr"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    ${t("chat.imageLightbox.position", { current: String(this.galleryController.index + 1), total: String(this.galleryController.count) })}
                  </p>
                  ${this.galleryController.failed ? html`<p class="gallery-error" role="alert">${t("chat.imageLightbox.loadFailed")}</p>` : nothing}
                `
              : nothing
          }
          ${
            this.mediaKind === "image"
              ? html`<div class="zoom-controls">
                  <button
                    class="action zoom-control"
                    type="button"
                    aria-label=${t("chat.imageLightbox.zoomOut")}
                    aria-disabled=${!canZoom || this.scale <= 1}
                    @click=${this.zoomOut}
                  >
                    −
                  </button>
                  <button
                    class="action zoom-control zoom-level"
                    type="button"
                    aria-label=${t("chat.imageLightbox.resetZoom")}
                    aria-disabled=${!canZoom || this.scale === 1}
                    @click=${this.resetZoom}
                  >
                    ${Math.round(this.scale * 100)}%
                  </button>
                  <button
                    class="action zoom-control"
                    type="button"
                    aria-label=${t("chat.imageLightbox.zoomIn")}
                    aria-disabled=${!canZoom || this.scale >= MAX_SCALE}
                    @click=${this.zoomIn}
                  >
                    +
                  </button>
                </div>`
              : nothing
          }
        </section>
      </openclaw-modal-dialog>
    `;
  }

  private handleImageLoad = (event: Event) => {
    const image = event.currentTarget;
    if (image instanceof HTMLImageElement && image === this.image) {
      this.initializePanzoom(image);
    }
  };

  private handleImageError = (event: Event) => {
    if (event.currentTarget !== this.image) {
      return;
    }
    this.destroyPanzoom();
    this.scale = 1;
  };

  private initializePanzoom(image: HTMLImageElement) {
    const stage = this.stage;
    if (!this.isConnected || !image.isConnected || !stage || image !== this.image) {
      return;
    }
    // A decoded resolution upgrade keeps the current image, pan, and zoom.
    if (image === this.panzoomImage && stage === this.panzoomStage) {
      return;
    }
    this.destroyPanzoom();
    this.panzoomImage = image;
    this.panzoomStage = stage;
    this.panzoom = Panzoom(image, {
      duration: this.motionQuery?.matches ? 0 : 200,
      maxScale: MAX_SCALE,
      minScale: 1,
      panOnlyWhenZoomed: true,
    });
    image.addEventListener("panzoomchange", this.handlePanzoomChange);
    stage.addEventListener("wheel", this.handleWheel, { passive: false });
    this.imageReady = true;
  }

  private destroyPanzoom() {
    const image = this.panzoomImage;
    image?.removeEventListener("panzoomchange", this.handlePanzoomChange);
    this.panzoomStage?.removeEventListener("wheel", this.handleWheel);
    this.panzoom?.destroy();
    this.panzoom?.resetStyle();
    image?.style.removeProperty("transform");
    image?.style.removeProperty("transition");
    this.panzoom = undefined;
    this.panzoomImage = undefined;
    this.panzoomStage = undefined;
    this.imageReady = false;
  }

  private handlePanzoomChange = (event: Event) => {
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
    this.scale = detail.scale;
  };

  private handleWheel = (event: WheelEvent) => {
    if (!this.panzoom) {
      return;
    }
    event.preventDefault();
    this.panzoom.zoomWithWheel(event);
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (!this.panzoom || this.suppressDoubleClick) {
      return;
    }
    event.preventDefault();
    if (this.scale > 1) {
      this.resetZoom();
      return;
    }
    this.panzoom?.zoomToPoint(DOUBLE_TAP_SCALE, event);
  };

  private handleStagePointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      this.touchPointers.add(event.pointerId);
      if (this.touchPointers.size > 1) {
        this.cancelSwipe();
        this.backdropPointer = undefined;
        return;
      }
    }
    this.suppressDoubleClick = false;
    const stage = event.currentTarget;
    if (event.button !== 0 || !event.isPrimary || !(stage instanceof HTMLElement)) {
      this.backdropPointer = undefined;
      return;
    }
    const background = event.target === stage || event.target === this.slide;
    this.backdropPointer = background
      ? { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
      : undefined;
    if (
      event.pointerType === "touch" &&
      this.hasGallery &&
      !this.galleryController.busy &&
      this.scale <= 1
    ) {
      this.slideAnimation?.cancel();
      this.swipe = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offset: 0,
        horizontal: false,
      };
      stage.setPointerCapture(event.pointerId);
    } else if (background) {
      stage.setPointerCapture?.(event.pointerId);
    }
  };

  private handleStagePointerMove = (event: PointerEvent) => {
    const swipe = this.swipe;
    if (!swipe || swipe.pointerId !== event.pointerId) {
      return;
    }
    if (this.scale > 1 || this.touchPointers.size !== 1) {
      this.cancelSwipe();
      return;
    }
    const x = event.clientX - swipe.x;
    const y = event.clientY - swipe.y;
    if (!swipe.horizontal) {
      if (Math.max(Math.abs(x), Math.abs(y)) < SWIPE_AXIS_THRESHOLD_PX) {
        return;
      }
      this.backdropPointer = undefined;
      this.suppressDoubleClick = true;
      if (Math.abs(y) >= Math.abs(x)) {
        this.cancelSwipe();
        return;
      }
      swipe.horizontal = true;
    }
    const delta = x * this.direction < 0 ? 1 : -1;
    swipe.offset = this.galleryController.canMove(delta) ? x : x * 0.2;
    if (this.slide) {
      this.slide.style.transform = `translateX(${swipe.offset}px)`;
    }
  };

  private handleStagePointerUp = (event: PointerEvent) => {
    this.touchPointers.delete(event.pointerId);
    const swipe = this.swipe;
    if (swipe?.pointerId === event.pointerId) {
      this.swipe = undefined;
      if (swipe.horizontal) {
        this.backdropPointer = undefined;
        const delta = swipe.offset * this.direction < 0 ? 1 : -1;
        if (
          Math.abs(swipe.offset) >= SWIPE_THRESHOLD_PX &&
          this.scale <= 1 &&
          this.galleryController.canMove(delta)
        ) {
          void this.navigate(delta, swipe.offset);
        } else {
          this.animateSlide(swipe.offset);
        }
        return;
      }
    }
    const pointer = this.backdropPointer;
    this.backdropPointer = undefined;
    const releaseTarget = this.shadowRoot?.elementFromPoint?.(event.clientX, event.clientY);
    const shouldClose =
      event.button === 0 &&
      event.isPrimary &&
      pointer?.pointerId === event.pointerId &&
      (releaseTarget === this.stage || releaseTarget === this.slide) &&
      Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) <= 4;
    if (shouldClose) {
      this.emitClose();
    }
  };

  private handleStagePointerCancel = (event: PointerEvent) => {
    this.touchPointers.delete(event.pointerId);
    this.backdropPointer = undefined;
    this.cancelSwipe();
  };

  private cancelSwipe() {
    const offset = this.swipe?.offset ?? 0;
    this.swipe = undefined;
    this.animateSlide(offset);
  }

  private animateSlide(offset: number) {
    this.slideAnimation?.cancel();
    const slide = this.slide;
    if (!slide) {
      return;
    }
    slide.style.removeProperty("transform");
    if (offset && !this.motionQuery?.matches && this.isConnected) {
      this.slideAnimation = slide.animate(
        [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
        { duration: SLIDE_DURATION_MS, easing: "ease-out" },
      );
    }
  }

  private async navigate(delta: number, offset = 0) {
    if (!this.hasGallery || !this.galleryController.canMove(delta)) {
      this.animateSlide(offset);
      return;
    }
    const changed = await this.galleryController.move(delta);
    if (!this.isConnected) {
      return;
    }
    await this.updateComplete;
    this.animateSlide(changed ? delta * this.direction * (this.stage?.clientWidth ?? 0) : offset);
  }

  private handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
    this.panzoom?.setOptions({ duration: event.matches ? 0 : 200 });
    if (event.matches) {
      this.slideAnimation?.cancel();
    }
  };

  private zoomIn = () => this.panzoom?.zoomIn();
  private zoomOut = () => this.panzoom?.zoomOut();
  private resetZoom = () => this.panzoom?.reset({ animate: false });

  private revokeOriginalBlobUrl() {
    if (!this.originalBlobUrl) {
      return;
    }
    URL.revokeObjectURL(this.originalBlobUrl);
    this.originalBlobUrl = "";
  }

  private async resolveOriginalUrl() {
    const request = ++this.originalUrlRequest;
    this.revokeOriginalBlobUrl();
    this.resolvingOriginal = false;
    if (this.currentImage?.loadFullResolution) {
      this.openOriginalUrl = "";
      return;
    }
    const source = (
      this.currentImage?.originalSrc ||
      this.currentImage?.src ||
      this.originalSrc ||
      this.src
    ).trim();
    if (!source) {
      this.openOriginalUrl = "";
      return;
    }
    const sourcePrefix = source.slice(0, 5).toLowerCase();
    const isDataUrl = sourcePrefix === "data:";
    const isBlobUrl = sourcePrefix === "blob:";
    if (!isDataUrl && !isBlobUrl) {
      this.openOriginalUrl = source;
      return;
    }
    this.openOriginalUrl = "";
    const sourceType = isDataUrl ? dataUrlMimeType(source) : undefined;
    // Reject active data formats before fetching. Incoming blob URLs still need
    // their fetched MIME checked because top-level blobs inherit the app origin.
    if (isDataUrl && (!sourceType || !SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES.has(sourceType))) {
      return;
    }
    this.resolvingOriginal = true;
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      if (
        !this.isConnected ||
        request !== this.originalUrlRequest ||
        !SAFE_TOP_LEVEL_IMAGE_BLOB_TYPES.has(mimeTypeEssence(blob.type))
      ) {
        return;
      }
      if (isBlobUrl) {
        this.openOriginalUrl = source;
        return;
      }
      this.originalBlobUrl = URL.createObjectURL(blob);
      this.openOriginalUrl = this.originalBlobUrl;
    } catch {
      // The image remains viewable inline; omit an unusable original-link action.
    } finally {
      if (request === this.originalUrlRequest) {
        this.resolvingOriginal = false;
      }
    }
  }

  private handleKeydown = (event: KeyboardEvent) => {
    if (panImageWithKeyboard(event, this.panzoom)) {
      return;
    }
    if (
      this.hasGallery &&
      !event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      event.stopPropagation();
      void this.navigate((event.key === "ArrowRight" ? 1 : -1) * this.direction);
      return;
    }
    if (this.panzoom && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      this.zoomIn();
      return;
    }
    if (this.panzoom && event.key === "-") {
      event.preventDefault();
      this.zoomOut();
      return;
    }
    if (this.panzoom && event.key === "0") {
      event.preventDefault();
      this.resetZoom();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const actions = [...this.focusables].filter(
      (action) => !(action instanceof HTMLButtonElement && action.disabled),
    );
    const first = actions[0];
    const last = actions.at(-1);
    if (!first || !last) {
      return;
    }
    const source = event.composedPath()[0];
    if (event.shiftKey && source === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && source === last) {
      event.preventDefault();
      first.focus();
    }
  };

  private emitClose = () => {
    this.dispatchEvent(
      new CustomEvent("image-lightbox-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

if (!customElements.get("openclaw-image-lightbox")) {
  customElements.define("openclaw-image-lightbox", OpenClawImageLightbox);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": OpenClawImageLightbox;
  }
}
