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

// Static PNG and JPEG uploads opt into preparation. Other formats keep ordinary admission.
export function canResizeChatAttachment(file: File): boolean {
  return file.type === "image/png" || file.type === "image/jpeg";
}

const MAX_IMAGE_RESIZE_PIXELS = 25_000_000;

async function checkResizeSource(file: File, signal: AbortSignal): Promise<void> {
  if (file.type === "image/jpeg") {
    await checkJpegResizeSource(file, signal);
  } else {
    await checkPngResizeSource(file, signal);
  }
}

async function checkPngResizeSource(file: File, signal: AbortSignal): Promise<void> {
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
  if (width === 0 || height === 0 || width * height > MAX_IMAGE_RESIZE_PIXELS) {
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

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

async function checkJpegResizeSource(file: File, signal: AbortSignal): Promise<void> {
  const head = new DataView(await file.slice(0, 2).arrayBuffer());
  signal.throwIfAborted();
  if (head.byteLength !== 2 || head.getUint8(0) !== 0xff || head.getUint8(1) !== 0xd8) {
    throw new Error("Invalid JPEG header");
  }
  // Walk JPEG segments to the first Start-of-Frame marker, reading declared
  // dimensions before the browser allocates source pixels. Standalone markers
  // carry no length; every other segment starts with its 2-byte length.
  let offset = 2;
  while (offset + 2 <= file.size) {
    signal.throwIfAborted();
    const marker = new DataView(await file.slice(offset, offset + 4).arrayBuffer());
    signal.throwIfAborted();
    if (marker.byteLength < 2 || marker.getUint8(0) !== 0xff || marker.getUint8(1) === 0x00) {
      throw new Error("Invalid JPEG header");
    }
    const type = marker.getUint8(1);
    if (type === 0xff) {
      offset += 1; // Fill byte before a marker.
      continue;
    }
    if (type === 0x01 || (type >= 0xd0 && type <= 0xd7) || type === 0xd8) {
      offset += 2; // Standalone markers carry no payload length.
      continue;
    }
    if (type === 0xd9) {
      break; // End of image before any frame data.
    }
    if (marker.byteLength !== 4) {
      throw new Error("Invalid JPEG header");
    }
    const length = marker.getUint16(2);
    if (length < 2 || offset + 2 + length > file.size) {
      throw new Error("Invalid JPEG header");
    }
    if (JPEG_SOF_MARKERS.has(type)) {
      const dimensions = new DataView(await file.slice(offset + 4, offset + 9).arrayBuffer());
      signal.throwIfAborted();
      if (dimensions.byteLength !== 5) {
        throw new Error("Invalid JPEG header");
      }
      const height = dimensions.getUint16(1);
      const width = dimensions.getUint16(3);
      // Match the media processor's 25 MP decode budget before the browser
      // allocates source pixels.
      if (width === 0 || height === 0 || width * height > MAX_IMAGE_RESIZE_PIXELS) {
        throw new Error("JPEG dimensions exceed the resize budget");
      }
      return;
    }
    if (type === 0xda) {
      throw new Error("JPEG image data is missing"); // Scan data before any frame header.
    }
    if (type === 0xe2 && length >= 6 && (await hasMpfIdentifier(file, offset + 4, signal))) {
      throw new Error("Multi-picture JPEG cannot be resized without losing frames");
    }
    offset += 2 + length;
  }
  throw new Error("JPEG image data is missing");
}

async function hasMpfIdentifier(file: File, start: number, signal: AbortSignal): Promise<boolean> {
  const bytes = new DataView(await file.slice(start, start + 4).arrayBuffer());
  signal.throwIfAborted();
  return (
    bytes.byteLength === 4 &&
    bytes.getUint8(0) === 0x4d &&
    bytes.getUint8(1) === 0x50 &&
    bytes.getUint8(2) === 0x46 &&
    bytes.getUint8(3) === 0x00
  );
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
