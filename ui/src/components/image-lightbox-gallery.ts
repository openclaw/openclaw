import { createSignal, onCleanup } from "solid-js";
import type { ImageLightboxGallery, ImageLightboxItem } from "./image-lightbox.types.ts";

// Cached items hold their decoded image; browsers may drop an unreferenced one and refetch it.
const decodedImages = new WeakMap<ImageLightboxItem, HTMLImageElement>();

async function decodeImage(item: ImageLightboxItem | null): Promise<ImageLightboxItem | null> {
  if (!item || item.kind === "video") {
    return item;
  }
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.src = item.src;
  try {
    await image.decode();
    decodedImages.set(item, image);
    return item;
  } catch {
    item.release?.();
    return null;
  }
}

function initialSelection(current?: ImageLightboxItem, gallery?: ImageLightboxGallery) {
  return {
    index: gallery?.index ?? 0,
    count: gallery?.items.length ?? 0,
    current,
    busy: false,
    failed: false,
    upgrading: false,
    upgradeFailed: false,
    videoStatus: "preparing",
    videoRetryable: true,
  };
}

/** The modal owns selected media and image resource leases until eviction or close. */
export function createImageLightboxGallery() {
  let selection = initialSelection();
  const [state, setState] = createSignal(selection);
  let video: HTMLVideoElement | undefined;
  let disconnectVideo: (() => void) | undefined;
  let gallery: ImageLightboxGallery | undefined;
  let images = new Map<number, Promise<ImageLightboxItem | null>>();
  // Admission and resource callbacks read this same receipt before Solid commits its display.
  const publish = (patch: Partial<typeof selection>) => {
    selection = { ...selection, ...patch };
    setState(selection);
  };

  function reset(nextGallery: ImageLightboxGallery | undefined, initial: ImageLightboxItem) {
    dispose();
    gallery = nextGallery;
    selection = initialSelection(initial, gallery);
    // The opener retains and releases the initial image independently of the modal.
    const preview = { ...initial, release: undefined };
    if (initial.loadDisplayImage) {
      void prepare(selection.index, initial.loadDisplayImage, preview);
    } else {
      images.set(selection.index, Promise.resolve(preview));
      publish({});
    }
    evictDistantImages();
  }

  function prepare(
    index: number,
    loader: () => Promise<ImageLightboxItem | null>,
    preview?: ImageLightboxItem,
  ) {
    if (preview) {
      publish({ upgrading: true, upgradeFailed: false });
    }
    const pending: Promise<ImageLightboxItem | null> = Promise.resolve()
      .then(() => (images.get(index) === pending ? loader() : null))
      .then(decodeImage)
      .catch(() => null)
      .then((item) => {
        if (preview && images.get(index) === pending && selection.index === index) {
          publish({ upgrading: false, upgradeFailed: !item, ...(item ? { current: item } : {}) });
        }
        if (!item && !preview && images.get(index) === pending) {
          images.delete(index);
        }
        return item ?? preview ?? null;
      });
    images.set(index, pending);
    return pending;
  }

  function dispose() {
    stopPlayer();
    for (const image of images.values()) {
      void image.then((item) => item?.release?.());
    }
    images = new Map();
    gallery = undefined;
  }

  function canMove(delta: number) {
    const next = selection.index + delta;
    return selection.count > 1 && next >= 0 && next < selection.count;
  }

  async function move(delta: number): Promise<boolean> {
    if (selection.busy || !canMove(delta)) {
      return false;
    }
    const activeImages = images;
    const next = selection.index + delta;
    publish({ busy: true, failed: false });
    const item = await load(next, true);
    if (activeImages !== images) {
      return false;
    }
    if (item) {
      stopPlayer();
      publish({
        index: next,
        current: item,
        busy: false,
        failed: false,
        upgrading: false,
        upgradeFailed: false,
      });
      evictDistantImages();
    } else {
      publish({ busy: false, failed: true });
    }
    return item !== null;
  }

  function connectPlayer(nextVideo?: HTMLVideoElement, retryFailed = false) {
    const item = selection.current;
    if (!nextVideo || item?.kind !== "video" || video === nextVideo) {
      return;
    }
    stopPlayer();
    video = nextVideo;
    publish({ videoStatus: "preparing" });
    if (item.connectVideo) {
      disconnectVideo = item.connectVideo(
        nextVideo,
        (status, retryable = true) => {
          if (video === nextVideo && selection.current === item) {
            publish({
              videoStatus: status === "ready" && nextVideo.readyState < 2 ? "preparing" : status,
              videoRetryable: retryable,
            });
          }
        },
        retryFailed,
      );
    } else {
      nextVideo.src = item.src;
    }
  }

  function updateVideoStatus(videoStatus: "ready" | "unavailable") {
    publish({ videoStatus });
  }

  function stopPlayer() {
    disconnectVideo?.();
    disconnectVideo = undefined;
    if (video?.hasAttribute("src")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    video = undefined;
  }

  function retryVideo() {
    const previous = video;
    stopPlayer();
    connectPlayer(previous, true);
  }

  function load(index: number, retryFailed = false): Promise<ImageLightboxItem | null> {
    const cached = images.get(index);
    if (cached) {
      return cached;
    }
    const loader = gallery?.items[index];
    return loader ? prepare(index, () => loader(retryFailed)) : Promise.resolve(null);
  }

  function retryDisplayImage() {
    const current = selection.current;
    if (current?.loadDisplayImage && !selection.upgrading) {
      void prepare(selection.index, current.loadDisplayImage, current);
    }
  }

  function evictDistantImages() {
    for (const [index, image] of images) {
      if (Math.abs(index - selection.index) > 1) {
        images.delete(index);
        void image.then((item) => item?.release?.());
      }
    }
    // Only selected media starts network/decode work; visited neighbors stay warm.
  }

  onCleanup(dispose);
  return {
    state,
    peek: () => selection,
    reset,
    canMove,
    move,
    connectPlayer,
    updateVideoStatus,
    stopPlayer,
    retryVideo,
    retryDisplayImage,
  };
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

export function trapLightboxTabFocus(event: KeyboardEvent, focusables: Iterable<HTMLElement>) {
  if (event.key !== "Tab") {
    return;
  }
  const actions = [...focusables]
    .filter(
      (action) =>
        action.isConnected &&
        action.tabIndex >= 0 &&
        !(action instanceof HTMLButtonElement && action.disabled),
    )
    .toSorted((left, right) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
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
