import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { listen } from "../../../lib/reactive/listener.ts";

export function dataImageClipboardFile(
  dataUrl: string,
  baseName = "pasted-image",
): { file: File; dataUrl: string } | null {
  const trimmed = dataUrl.trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(trimmed);
  const mimeType = match?.[1]?.toLowerCase();
  const base64 = match ? trimmed.slice(match[0].length).replace(/\s+/g, "") : undefined;
  if (!mimeType || !base64) {
    return null;
  }
  try {
    return {
      file: new File([base64ToBytes(base64)], `${baseName}.${mimeType.slice("image/".length)}`, {
        type: mimeType,
      }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

// Only formats whose dimensions we can inspect before decoding opt into preparation.
export function canResizeChatAttachment(file: File): boolean {
  return file.type === "image/png" || file.type === "image/jpeg";
}

// Admit the 37.45 MP photo case without allowing unbounded browser source allocation.
const MAX_JPEG_SOURCE_PIXELS = 40_000_000;

async function readResizeDimensions(
  file: File,
  signal: AbortSignal,
): Promise<{ width: number; height: number }> {
  if (file.type === "image/jpeg") {
    const signature = new DataView(await file.slice(0, 2).arrayBuffer());
    signal.throwIfAborted();
    if (signature.byteLength !== 2 || signature.getUint16(0) !== 0xffd8) {
      throw new Error("Invalid JPEG header");
    }
    // Walk marker headers, not compressed pixels or potentially large EXIF data.
    for (
      let offset = 2, markers = 0;
      offset + 4 <= file.size && offset < 1024 * 1024 && markers < 256;
      markers += 1
    ) {
      const header = new DataView(await file.slice(offset, offset + 9).arrayBuffer());
      signal.throwIfAborted();
      if (header.getUint8(0) !== 0xff) {
        break;
      }
      const marker = header.getUint8(1);
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xda || marker === 0xd9 || marker === 0xd8) {
        break;
      }
      // TEM and restart markers have no segment length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = header.getUint16(2);
      if (length < 2 || length > file.size - offset - 2) {
        break;
      }
      // Baseline, extended sequential, and progressive Huffman JPEG.
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (length < 8 || header.byteLength < 9) {
          break;
        }
        const height = header.getUint16(5);
        const width = header.getUint16(7);
        // A bounded downscale may admit phone photos above the default 25 MP
        // media limit. Do not remove source admission just because output is small.
        if (width === 0 || height === 0 || width * height > MAX_JPEG_SOURCE_PIXELS) {
          throw new Error("JPEG dimensions exceed the resize budget");
        }
        return { width, height };
      }
      // Lossless and arithmetic-coded SOFs are not supported by this preparation path.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        break;
      }
      offset += length + 2;
    }
    throw new Error("JPEG dimensions are missing or unsupported");
  }
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
  // Bound source allocation before decode, independently of the output canvas.
  if (width === 0 || height === 0 || width * height > 25_000_000) {
    throw new Error("PNG dimensions exceed the resize budget");
  }
  return { width, height };
}

async function checkPngAnimation(file: File, signal: AbortSignal): Promise<void> {
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
  const { width, height } = await readResizeDimensions(file, signal);
  if (file.size <= maxBytes && Math.max(width, height) <= 4096) {
    return file;
  }
  if (file.type === "image/png") {
    await checkPngAnimation(file, signal);
  }
  // Queue wait is not a stalled read. Each worker gets the full read watchdog.
  onProcessingChange(false);
  const prepared = preparationQueue.then(() => {
    signal.throwIfAborted();
    onProcessingChange(true);
    return new Promise<File>((resolve, reject) => {
      const worker = new Worker(new URL("./chat-attachment-image.worker.ts", import.meta.url), {
        type: "module",
      });
      const listeners = new AbortController();
      const listenerOptions = { once: true, signal: listeners.signal };
      let settled = false;
      const finish = (result: File | null) => {
        if (settled) {
          return;
        }
        settled = true;
        listeners.abort();
        worker.terminate();
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
      listen(signal, "abort", abort, listenerOptions);
      listen(
        worker,
        "message",
        ({ data }: MessageEvent<File | null>) => finish(data),
        listenerOptions,
      );
      listen(
        worker,
        "error",
        (event) => {
          event.preventDefault();
          finish(null);
        },
        listenerOptions,
      );
      listen(worker, "messageerror", () => finish(null), listenerOptions);
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
