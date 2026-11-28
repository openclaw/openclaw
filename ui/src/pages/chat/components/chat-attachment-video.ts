import { listen } from "../../../lib/reactive/listener.ts";

export type VideoCompressionRequest = { file: File; maxBytes: number };
export type VideoCompressionError = "unsupported" | "too-large" | "failed";
export type VideoCompressionStage =
  | "input"
  | "codec"
  | "budget"
  | "conversion"
  | "encoding"
  | "output";
export type VideoCompressionDiagnostic =
  | `${VideoCompressionStage}/${VideoCompressionError}`
  | `worker/${"start" | "runtime" | "message" | "stall" | "post"}`
  | "load/failed";

class VideoCompressionFailure extends Error {
  constructor(
    readonly reason: VideoCompressionError,
    readonly diagnostic: VideoCompressionDiagnostic,
  ) {
    super(reason);
  }
}

// Only our stage/code vocabulary leaves the compressor, never codec exceptions,
// URLs, filenames, or browser error text. The tile can report this on mobile.
export function describeVideoCompressionFailure(error: unknown): {
  reason: VideoCompressionError;
  diagnostic: VideoCompressionDiagnostic;
} {
  return error instanceof VideoCompressionFailure
    ? error
    : { reason: "failed", diagnostic: "worker/runtime" };
}
export type VideoCompressionResponse =
  | { type: "progress"; progress: number }
  | { type: "ready"; file: File }
  | { type: "error"; reason: VideoCompressionError; stage: VideoCompressionStage };

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
      let worker: Worker;
      try {
        worker = new Worker(new URL("./chat-attachment-video.worker.ts", import.meta.url), {
          type: "module",
        });
      } catch {
        reject(new VideoCompressionFailure("failed", "worker/start"));
        return;
      }
      const listeners = new AbortController();
      const listenerOptions = { signal: listeners.signal };
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = (
        prepared?: File,
        reason: VideoCompressionError = "failed",
        diagnostic: VideoCompressionDiagnostic = "worker/runtime",
      ) => {
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
          reject(
            signal.aborted ? new Error("aborted") : new VideoCompressionFailure(reason, diagnostic),
          );
        }
      };
      const abort = () => finish();
      // Encoding is not a FileReader operation: allow slow codec initialization
      // and reset this stall watchdog on progress, rather than a 15-second total.
      const armWatchdog = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(undefined, "failed", "worker/stall"), 120_000);
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
            finish(undefined, data.reason, `${data.stage}/${data.reason}`);
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
      listen(
        worker,
        "messageerror",
        () => finish(undefined, "failed", "worker/message"),
        listenerOptions,
      );
      armWatchdog();
      try {
        worker.postMessage({ file, maxBytes } satisfies VideoCompressionRequest, []);
      } catch {
        finish(undefined, "failed", "worker/post");
      }
    });
  });
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}
