import { listen } from "../../../lib/reactive/listener.ts";

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
      const listeners = new AbortController();
      const listenerOptions = { signal: listeners.signal };
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = (prepared?: File, reason: VideoCompressionError = "failed") => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        listeners.abort();
        worker.terminate();
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
      listen(signal, "abort", abort, { ...listenerOptions, once: true });
      listen(
        worker,
        "message",
        ({ data }: MessageEvent<VideoCompressionResponse>) => {
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
        },
        listenerOptions,
      );
      listen(
        worker,
        "error",
        (event) => {
          event.preventDefault();
          finish();
        },
        listenerOptions,
      );
      listen(worker, "messageerror", () => finish(), listenerOptions);
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
