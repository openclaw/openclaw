import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhoton } from "./photon.js";

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
  // Already PNG, no conversion needed
  if (mimeType === "image/png") {
    return { data: base64Data, mimeType };
  }

  const photon = await loadPhoton();
  if (!photon) {
    // Photon not available, can't convert
    return null;
  }

  try {
    const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
    const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
    const image = applyExifOrientation(photon, rawImage, bytes);
    if (image !== rawImage) {
      rawImage.free();
    }
    try {
      const pngBuffer = image.get_bytes();
      return {
        data: Buffer.from(pngBuffer).toString("base64"),
        mimeType: "image/png",
      };
    } finally {
      image.free();
    }
  } catch {
    // Conversion failed
    return null;
  }
}
