import qrcode from "qrcode";
import { renderOpenClawMascot } from "../../../src/shared/openclaw-mascot.ts";

const QUIET_ZONE = 4;
const SUBMODULES = 3;
const PIXEL_SCALE = 3;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export type PublicShareQr = { plain: string; halftone?: string };

/** Client-side only: public-link tokens and artwork never go to a QR service. */
export async function createPublicShareQr(url: string): Promise<PublicShareQr> {
  const symbol = qrcode.create(url, { errorCorrectionLevel: "H" });
  const { size, data, reservedBit } = symbol.modules;
  const width = (size + QUIET_ZONE * 2) * SUBMODULES * PIXEL_SCALE;
  const plain = await qrcode.toDataURL(url, {
    errorCorrectionLevel: "H",
    margin: QUIET_ZONE,
    width,
  });
  // Dense symbols lose the tiny image cells at the share panel's display size.
  if (size > 61) {
    return { plain };
  }
  try {
    const imageSize = size * SUBMODULES;
    const image = await mascotPixels(imageSize);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = width;
    const context = canvas.getContext("2d");
    if (!context) {
      return { plain };
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, width);
    // Chu et al.'s halftone QR technique (Hackaday, November 6, 2026):
    // preserve module centres, put the image in surrounding submodules. Keep
    // all peripheral tones on the QR bit's side of the threshold (0–64 for
    // dark, 192–255 for light). The original binary periphery failed scanning
    // at 240 px; this contrast bound survives downsampling. Function marks
    // and the four-module quiet zone stay untouched.
    for (let y = 0; y < imageSize; y++) {
      for (let x = 0; x < imageSize; x++) {
        const module = Math.floor(y / SUBMODULES) * size + Math.floor(x / SUBMODULES);
        const qrCell = reservedBit[module] || (x % SUBMODULES === 1 && y % SUBMODULES === 1);
        let shade = data[module] ? 0 : 255;
        if (!qrCell) {
          const pixel = (y * imageSize + x) * 4;
          const luminance =
            (image[pixel]! * 0.2126 + image[pixel + 1]! * 0.7152 + image[pixel + 2]! * 0.0722) /
            255;
          const imageDot = luminance < (BAYER[(y % 4) * 4 + (x % 4)]! + 0.5) / 16;
          shade = data[module] ? (imageDot ? 0 : 64) : imageDot ? 192 : 255;
        }
        if (shade !== 255) {
          context.fillStyle = "rgb(" + shade + "," + shade + "," + shade + ")";
          context.fillRect(
            (x + QUIET_ZONE * SUBMODULES) * PIXEL_SCALE,
            (y + QUIET_ZONE * SUBMODULES) * PIXEL_SCALE,
            PIXEL_SCALE,
            PIXEL_SCALE,
          );
        }
      }
    }
    return { plain, halftone: canvas.toDataURL("image/png") };
  } catch {
    // Missing image/canvas support must not remove the usable standard code.
    return { plain };
  }
}

async function mascotPixels(size: number): Promise<Uint8ClampedArray> {
  // Reuse the canonical brand artwork, without animation or network requests.
  const artwork = new DOMParser().parseFromString(renderOpenClawMascot("share-qr"), "text/html");
  const svg = artwork.querySelector("svg");
  if (!svg) {
    throw new Error("Missing OpenClaw mascot");
  }
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const image = new Image();
  image.src =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas unavailable");
  }
  context.fillStyle = "#fff";
  context.fillRect(0, 0, size, size);
  const inset = size * 0.08;
  context.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
  return context.getImageData(0, 0, size, size).data;
}
