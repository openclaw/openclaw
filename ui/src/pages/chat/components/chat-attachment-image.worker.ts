import type { ChatAttachmentImageRequest } from "./chat-attachment-image.ts";

async function resize(file: File, maxBytes: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(1, 1);
  try {
    const context = canvas.getContext("2d");
    if (!context || bitmap.width < 1 || bitmap.height < 1) {
      throw new Error("Image cannot be resized");
    }
    // Bound the working canvas to 64 MiB of RGBA pixels. Start near the
    // requested byte ratio, then measure real encodings rather than guessing
    // from dimensions or relying on PNG's ignored quality argument.
    let scale = Math.min(
      1,
      4096 / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(maxBytes / file.size) * 0.95,
    );
    while (true) {
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: file.type });
      if (!blob || blob.size === 0 || blob.type !== file.type) {
        throw new Error("Image encoding failed");
      }
      if (blob.size <= maxBytes) {
        return new File([blob], file.name, { type: blob.type, lastModified: file.lastModified });
      }
      if (canvas.width === 1 && canvas.height === 1) {
        throw new Error("Image cannot fit the attachment limit");
      }
      scale *= Math.min(0.8, Math.sqrt(maxBytes / blob.size) * 0.95);
    }
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}

globalThis.addEventListener("message", ({ data }: MessageEvent<ChatAttachmentImageRequest>) => {
  void resize(data.file, data.maxBytes).then(
    (file) => globalThis.postMessage(file, { transfer: [] }),
    () => globalThis.postMessage(null, { transfer: [] }),
  );
});
