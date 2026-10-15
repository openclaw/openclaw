export type VideoCompressionRequest = { file: File; maxBytes: number };
export type VideoCompressionError = "unsupported" | "too-large" | "failed";
export type VideoCompressionResponse =
  | { type: "progress"; progress: number }
  | { type: "ready"; file: File }
  | { type: "error"; reason: VideoCompressionError };

// Serialize encoders, not the composer. Each job owns a worker; termination also
// releases native codec resources when a draft is replaced or a file is removed.
let queue = Promise.resolve();

export function compressChatAttachmentVideo(
  file: File,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<File> {
  const result = queue.then(() => {
    signal.throwIfAborted();
    return new Promise<File>((resolve, reject) => {
      const worker = new Worker(new URL("./chat-attachment-video.worker.ts", import.meta.url), {
        type: "module",
      });
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = (prepared?: File, reason: VideoCompressionError = "failed") => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        signal.removeEventListener("abort", abort);
        if (prepared && !signal.aborted) {
          resolve(prepared);
        } else {
          reject(new Error(signal.aborted ? "aborted" : reason));
        }
      };
      const abort = () => finish();
      // Encoding is not a FileReader operation: allow slow codec initialization
      // and reset this stall watchdog on progress, rather than a 15-second total.
      const armWatchdog = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(), 120_000);
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.addEventListener("message", ({ data }: MessageEvent<VideoCompressionResponse>) => {
        if (settled) {
          return;
        }
        if (data.type === "progress") {
          armWatchdog();
          onProgress(data.progress);
        } else if (data.type === "ready") {
          finish(data.file);
        } else {
          finish(undefined, data.reason);
        }
      });
      worker.addEventListener("error", (event) => {
        event.preventDefault();
        finish();
      });
      worker.addEventListener("messageerror", () => finish());
      armWatchdog();
      try {
        worker.postMessage({ file, maxBytes } satisfies VideoCompressionRequest, []);
      } catch {
        finish();
      }
    });
  });
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}
