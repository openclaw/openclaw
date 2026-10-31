import { beginClipboardCopy } from "../../../lib/clipboard.ts";

export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  // SVG is decoded in image context, never executed as a document. The lightbox
  // and clipboard receive raster bytes; the separate file download keeps the original.
  const svg = blob.type.split(";", 1)[0] === "image/svg+xml";
  const url = svg ? URL.createObjectURL(blob) : undefined;
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    if (url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      bitmap = image;
    } else {
      bitmap = await createImageBitmap(blob);
    }
  } catch (error) {
    if (url) {
      URL.revokeObjectURL(url);
    }
    throw error;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap instanceof HTMLImageElement ? bitmap.naturalWidth : bitmap.width;
    canvas.height = bitmap instanceof HTMLImageElement ? bitmap.naturalHeight : bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("image conversion context is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (converted) =>
          converted ? resolve(converted) : reject(new Error("image conversion failed")),
        "image/png",
      );
    });
  } finally {
    if (bitmap instanceof ImageBitmap) {
      bitmap.close();
    }
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}

export async function copyImageToClipboard(readBlob: () => Promise<Blob>): Promise<void> {
  beginClipboardCopy();
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("image clipboard is unavailable");
  }
  const png = readBlob().then(convertImageBlobToPng);
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
