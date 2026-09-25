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

function createPoster(src: string, width: number, height: number): PosterEntry {
  const controller = new AbortController();
  const { signal } = controller;
  const promise = new Promise<Blob | null>((resolve) => {
    let cleanup = () => {
      queue.delete(start);
    };
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) {
        return;
      }
      settled = true;
      controller.abort();
      cleanup();
      resolve(blob);
    };
    const abort = () => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    const start = () => {
      active += 1;
      const video = document.createElement("video");
      const canvas = document.createElement("canvas");
      let frameCallback: number | undefined;
      const timeout = setTimeout(abort, 2000);
      cleanup = () => {
        clearTimeout(timeout);
        if (frameCallback !== undefined) {
          video.cancelVideoFrameCallback(frameCallback);
        }
        video.removeAttribute("src");
        video.load();
        canvas.width = canvas.height = 0;
        active -= 1;
        schedule();
      };
      const options = { once: true, signal };
      // Consume the initial compositor frame before waiting for the sought frame.
      const waitForFrame = (event: "loadedmetadata" | "seeked", next: () => void) => {
        let pending = 2;
        const ready = () => {
          if (!settled && --pending === 0) {
            next();
          }
        };
        video.addEventListener(event, ready, options);
        frameCallback = video.requestVideoFrameCallback(ready);
      };
      const capture = () => {
        try {
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) {
            return abort();
          }
          const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
          const w = video.videoWidth * scale;
          const h = video.videoHeight * scale;
          context.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
          canvas.toBlob(finish, "image/jpeg", 0.8);
        } catch {
          abort();
        }
      };
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.addEventListener("error", abort, options);
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (
            !Number.isFinite(video.duration) ||
            video.duration <= 0 ||
            video.videoWidth * video.videoHeight > 16_777_216
          ) {
            abort();
          }
        },
        options,
      );
      if (typeof video.requestVideoFrameCallback !== "function") {
        return abort();
      }
      waitForFrame("loadedmetadata", () => {
        waitForFrame("seeked", capture);
        video.currentTime = Math.min(0.1, video.duration / 10);
      });
      video.src = src;
      video.load();
    };
    queue.add(start);
    schedule();
  });
  return { controller, owners: new Set(), promise };
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
    ![width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 512)
  ) {
    return Promise.resolve(null);
  }
  const owned = posters.get(key) ?? createPoster(src, width, height);
  posters.set(key, owned);
  if (!owned.owners.has(signal)) {
    owned.owners.add(signal);
    signal.addEventListener(
      "abort",
      () => {
        owned.owners.delete(signal);
        if (owned.owners.size === 0) {
          posters.delete(key);
          owned.controller.abort();
        }
      },
      { once: true },
    );
  }
  return owned.promise.then((blob) => (signal.aborted ? null : blob));
}
