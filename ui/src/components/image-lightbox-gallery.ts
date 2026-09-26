import type { ImageLightboxGallery, ImageLightboxItem } from "./image-lightbox.types.ts";

async function decodeImage(item: ImageLightboxItem | null): Promise<ImageLightboxItem | null> {
  if (!item || item.kind === "video") {
    return item;
  }
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.src = item.src;
  try {
    await image.decode();
    return item;
  } catch {
    item.release?.();
    return null;
  }
}

/** The modal owns selected media and image resource leases until eviction or close. */
export class ImageLightboxGalleryController {
  index = 0;
  current: ImageLightboxItem | undefined;
  busy = false;
  failed = false;
  videoStatus: "preparing" | "ready" | "unavailable" = "preparing";
  videoRetryable = true;
  private video?: HTMLVideoElement;
  private disconnectVideo?: () => void;
  private gallery: ImageLightboxGallery | undefined;
  private generation = 0;
  private readonly images = new Map<number, Promise<ImageLightboxItem | null>>();

  constructor(private readonly notify: () => void) {}

  get count() {
    return this.gallery?.items.length ?? 0;
  }

  reset(gallery: ImageLightboxGallery | undefined, initial: ImageLightboxItem) {
    this.dispose();
    this.gallery = gallery;
    this.index = gallery?.index ?? 0;
    this.current = initial;
    // The opener retains and releases the initial image independently of the modal.
    const preview = { ...initial, release: undefined };
    if (initial.loadFullResolution) {
      this.upgrade(this.index, preview, initial.loadFullResolution);
    } else {
      this.images.set(this.index, Promise.resolve(preview));
    }
    this.preloadNeighbors();
  }

  private upgrade(
    index: number,
    preview: ImageLightboxItem,
    load: () => Promise<ImageLightboxItem | null>,
  ) {
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(() => (generation === this.generation ? load() : null))
      .then(decodeImage)
      .catch(() => null)
      .then((item) => {
        if (
          item &&
          generation === this.generation &&
          this.images.get(index) === pending &&
          this.index === index
        ) {
          this.current = item;
          this.notify();
        }
        return item ?? preview;
      });
    this.images.set(index, pending);
  }

  dispose() {
    this.stopPlayer();
    this.generation += 1;
    for (const image of this.images.values()) {
      void image.then((item) => item?.release?.());
    }
    this.images.clear();
    this.gallery = undefined;
    this.current = undefined;
    this.busy = false;
    this.failed = false;
  }

  canMove(delta: number) {
    const next = this.index + delta;
    return this.count > 1 && next >= 0 && next < this.count;
  }

  async move(delta: number): Promise<boolean> {
    if (this.busy || !this.canMove(delta)) {
      return false;
    }
    const generation = this.generation;
    const next = this.index + delta;
    this.busy = true;
    this.failed = false;
    this.notify();
    const item = await this.load(next, true);
    if (generation !== this.generation) {
      return false;
    }
    this.busy = false;
    this.failed = !item;
    if (item) {
      this.stopPlayer();
      this.index = next;
      this.current = item;
      this.preloadNeighbors();
    }
    this.notify();
    return item !== null;
  }

  connectPlayer(video?: HTMLVideoElement, retryFailed = false) {
    const item = this.current;
    if (!video || item?.kind !== "video" || this.video === video) {
      return;
    }
    this.stopPlayer();
    this.video = video;
    this.videoStatus = "preparing";
    if (item.connectVideo) {
      this.disconnectVideo = item.connectVideo(
        video,
        (status, retryable = true) => {
          if (this.video !== video || this.current !== item) {
            return;
          }
          this.videoStatus = status === "ready" && video.readyState < 2 ? "preparing" : status;
          this.videoRetryable = retryable;
          this.notify();
        },
        retryFailed,
      );
    } else {
      video.src = item.src;
    }
  }

  videoReady() {
    this.videoStatus = "ready";
    this.notify();
  }

  stopPlayer() {
    this.disconnectVideo?.();
    this.disconnectVideo = undefined;
    if (this.video?.hasAttribute("src")) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = undefined;
  }

  retryVideo() {
    const video = this.video;
    this.stopPlayer();
    this.connectPlayer(video, true);
  }

  private load(index: number, retryFailed = false): Promise<ImageLightboxItem | null> {
    const cached = this.images.get(index);
    if (cached) {
      return cached;
    }
    const load = this.gallery?.items[index];
    if (!load) {
      return Promise.resolve(null);
    }
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(() => (generation === this.generation ? load(retryFailed) : null))
      .then(decodeImage)
      .catch(() => null);
    this.images.set(index, pending);
    void pending.then((item) => {
      if (!item && this.images.get(index) === pending) {
        this.images.delete(index);
      }
    });
    return pending;
  }

  private preloadNeighbors() {
    for (const [index, image] of this.images) {
      if (Math.abs(index - this.index) > 1) {
        this.images.delete(index);
        void image.then((item) => item?.release?.());
      }
    }
    // Do not prepare hidden players or capture neighbor tickets speculatively.
    if (this.current?.kind === "video") {
      return;
    }
    for (const index of [this.index - 1, this.index + 1]) {
      if (index >= 0 && index < this.count) {
        void this.load(index);
      }
    }
  }
}

/** Native control internals retarget to video; leave their bottom strip and fullscreen alone. */
export function canSwipeLightboxVideo(video: HTMLVideoElement | undefined, event: PointerEvent) {
  const root = video?.getRootNode();
  if (
    !video ||
    document.fullscreenElement ||
    (root instanceof ShadowRoot && root.fullscreenElement)
  ) {
    return false;
  }
  if (!event.composedPath().includes(video)) {
    return true;
  }
  const bounds = video.getBoundingClientRect();
  return event.clientY < bounds.bottom - Math.min(80, bounds.height / 2);
}

/** Native controls can send dialog cancellation instead of a DOM Escape key. */
export function exitLightboxVideoFullscreen(video: HTMLVideoElement | undefined, event: Event) {
  if (!video?.matches(":fullscreen")) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  void video.ownerDocument.exitFullscreen().catch(() => undefined);
  return true;
}

export function trapLightboxTabFocus(event: KeyboardEvent, focusables: NodeListOf<HTMLElement>) {
  if (event.key !== "Tab") {
    return;
  }
  const actions = [...focusables].filter(
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
}
