// Only PNG uploads opt into preparation. Other formats keep ordinary admission.
export function canResizeChatAttachment(file: File): boolean {
  return file.type === "image/png";
}

async function checkResizeSource(file: File, signal: AbortSignal): Promise<void> {
  const header = new DataView(await file.slice(0, 33).arrayBuffer());
  signal.throwIfAborted();
  if (
    header.byteLength !== 33 ||
    header.getUint32(0) !== 0x89504e47 ||
    header.getUint32(4) !== 0x0d0a1a0a ||
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452
  ) {
    throw new Error("Invalid PNG header");
  }
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  // Match the media processor's 25 MP decode budget, before asking the browser
  // to allocate source pixels. The output canvas bound alone cannot do this.
  if (width === 0 || height === 0 || width * height > 25_000_000) {
    throw new Error("PNG dimensions exceed the resize budget");
  }
  // PNG's animation control must precede IDAT. Skip metadata by declared length
  // without buffering it; do not silently flatten an oversized APNG to frame 1.
  for (let offset = 33; offset + 12 <= file.size;) {
    signal.throwIfAborted();
    const chunk = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    signal.throwIfAborted();
    const length = chunk.getUint32(0);
    const type = chunk.getUint32(4);
    if (length > file.size - offset - 12 || type === 0x49484452) {
      break;
    }
    if (type === 0x6163544c) {
      throw new Error("Animated PNG cannot be resized without losing animation");
    }
    if (type === 0x49444154) {
      return;
    }
    offset += length + 12;
  }
  throw new Error("PNG image data is missing");
}

export type ChatAttachmentImageRequest = { file: File; maxBytes: number };

// One decode at a time bounds pixel memory and avoids a batch of encoders
// competing with typing. Each task owns its worker so abort stops native work.
let preparationQueue = Promise.resolve();

export async function resizeChatAttachmentImage(
  file: File,
  maxBytes: number,
  signal: AbortSignal,
  onProcessingChange: (processing: boolean) => void,
): Promise<File> {
  signal.throwIfAborted();
  await checkResizeSource(file, signal);
  // Queue wait is not a stalled read. Each worker gets the full read watchdog.
  onProcessingChange(false);
  const prepared = preparationQueue.then(() => {
    signal.throwIfAborted();
    onProcessingChange(true);
    return new Promise<File>((resolve, reject) => {
      const worker = new Worker(new URL("./chat-attachment-image.worker.ts", import.meta.url), {
        type: "module",
      });
      let settled = false;
      const finish = (result: File | null) => {
        if (settled) {
          return;
        }
        settled = true;
        worker.terminate();
        signal.removeEventListener("abort", abort);
        if (result && !signal.aborted) {
          resolve(result);
        } else {
          reject(
            signal.aborted
              ? new DOMException("Image preparation aborted", "AbortError")
              : new Error("Image preparation failed"),
          );
        }
      };
      const abort = () => finish(null);
      signal.addEventListener("abort", abort, { once: true });
      worker.addEventListener("message", ({ data }: MessageEvent<File | null>) => finish(data), {
        once: true,
      });
      worker.addEventListener(
        "error",
        (event) => {
          event.preventDefault();
          finish(null);
        },
        { once: true },
      );
      worker.addEventListener("messageerror", () => finish(null), { once: true });
      try {
        worker.postMessage({ file, maxBytes } satisfies ChatAttachmentImageRequest, []);
      } catch {
        finish(null);
      }
    });
  });
  preparationQueue = prepared.then(
    () => {},
    () => {},
  );
  return prepared;
}
