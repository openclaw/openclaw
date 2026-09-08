type PosterEntry = {
  controller: AbortController;
  owners: Set<AbortSignal>;
  promise: Promise<Blob | null>;
};

const posters = new Map<object | string, PosterEntry>();
const queue = new Set<() => void>();
let active = 0;
let scheduled = false;

function schedule(): void {
  if (scheduled || active >= 2 || queue.size === 0) {
    return;
  }
  scheduled = true;
  const start = () => {
    scheduled = false;
    for (const job of queue) {
      if (active >= 2) {
        break;
      }
      queue.delete(job);
      job();
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 500 });
  } else {
    setTimeout(start, 0);
  }
}

function decodePoster(
  src: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let canvas: HTMLCanvasElement | undefined;
    let frameCallback: number | undefined;
    let metadataReady = false;
    let initialFrameReady = false;
    let frameReady = false;
    let seeked = false;
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (frameCallback !== undefined) {
        video.cancelVideoFrameCallback(frameCallback);
      }
      video.removeEventListener("loadedmetadata", loadedMetadata);
      video.removeEventListener("seeked", seekComplete);
      video.removeEventListener("error", abort);
      video.removeAttribute("src");
      video.load();
      if (canvas) {
        canvas.width = canvas.height = 0;
      }
      resolve(blob);
    };
    const abort = () => finish(null);
    const timeout = setTimeout(abort, 2000);
    signal.addEventListener("abort", abort, { once: true });
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    const loadedMetadata = () => {
      if (
        !Number.isFinite(video.duration) ||
        video.duration <= 0 ||
        video.videoWidth * video.videoHeight > 16_777_216
      ) {
        finish(null);
        return;
      }
      metadataReady = true;
      seek();
    };
    const seek = () => {
      if (settled || !metadataReady || !initialFrameReady) {
        return;
      }
      // Consume the initial frame before seeking so it cannot satisfy the
      // sought-frame fence. Seek completion alone can still yield black pixels.
      frameCallback = video.requestVideoFrameCallback(() => {
        frameReady = true;
        if (seeked) {
          capture();
        }
      });
      video.currentTime = Math.min(0.1, video.duration / 10);
    };
    const seekComplete = () => {
      seeked = true;
      if (frameReady) {
        capture();
      }
    };
    const capture = () => {
      if (settled) {
        return;
      }
      try {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          finish(null);
          return;
        }
        const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
        const sourceWidth = width / scale;
        const sourceHeight = height / scale;
        context.drawImage(
          video,
          (video.videoWidth - sourceWidth) / 2,
          (video.videoHeight - sourceHeight) / 2,
          sourceWidth,
          sourceHeight,
          0,
          0,
          width,
          height,
        );
        canvas.toBlob(finish, "image/jpeg", 0.8);
      } catch {
        finish(null);
      }
    };
    if (typeof video.requestVideoFrameCallback !== "function") {
      finish(null);
      return;
    }
    frameCallback = video.requestVideoFrameCallback(() => {
      initialFrameReady = true;
      seek();
    });
    video.addEventListener("loadedmetadata", loadedMetadata, { once: true });
    video.addEventListener("seeked", seekComplete, { once: true });
    video.addEventListener("error", abort, { once: true });
    video.src = src;
    video.load();
  });
}

function enqueuePoster(
  src: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const cancel = () => {
      queue.delete(start);
      resolve(null);
    };
    const start = () => {
      signal.removeEventListener("abort", cancel);
      active += 1;
      void decodePoster(src, width, height, signal)
        .then(resolve)
        .finally(() => {
          active -= 1;
          schedule();
        });
    };
    signal.addEventListener("abort", cancel, { once: true });
    queue.add(start);
    schedule();
  });
}

/**
 * A key identifies immutable video content and output dimensions. Abort each
 * owner's signal when it no longer needs the cached result, including failures.
 * Keep src valid until the returned promise settles, even after owner abort.
 */
export function requestVideoPoster(params: {
  key: object | string;
  src: string;
  width: number;
  height: number;
  signal: AbortSignal;
}): Promise<Blob | null> {
  const { key, src, width, height, signal } = params;
  if (
    signal.aborted ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 512 ||
    height > 512
  ) {
    return Promise.resolve(null);
  }
  let entry = posters.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {
      controller,
      owners: new Set(),
      promise: enqueuePoster(src, width, height, controller.signal),
    };
    posters.set(key, entry);
  }
  const owned = entry;
  if (!owned.owners.has(signal)) {
    owned.owners.add(signal);
    signal.addEventListener(
      "abort",
      () => {
        owned.owners.delete(signal);
        if (owned.owners.size === 0) {
          if (posters.get(key) === owned) {
            posters.delete(key);
          }
          owned.controller.abort();
        }
      },
      { once: true },
    );
  }
  return owned.promise.then((blob) => (signal.aborted ? null : blob));
}
