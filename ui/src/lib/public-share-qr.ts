import qrcode from "qrcode";

const QUIET_ZONE = 4;
const SUBMODULES = 3;
const PIXEL_SCALE = 3;

// Broad pincer and open notch stay recognizable through the QR module centers.
const CLAW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M28 91 9 72 22 59C14 49 14 33 22 22C32 8 48 7 60 11L42 33 56 47 80 23C88 34 91 48 83 61C76 73 62 77 49 72Z"/></svg>';

type PublicShareQr = { halftone: string };

/** Client-side only: public-link tokens and artwork never go to a QR service. */
export async function createPublicShareQr(url: string): Promise<PublicShareQr | undefined> {
  try {
    const { size, data, reservedBit } = qrcode.create(url, { errorCorrectionLevel: "H" }).modules;
    const width = (size + QUIET_ZONE * 2) * SUBMODULES * PIXEL_SCALE;
    const imageSize = size * SUBMODULES;
    const image = await clawPixels(imageSize);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = width;
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, width);
    // Image-led periphery, exact center bit: only data modules are halftoned.
    // Function modules and the four-module quiet zone remain solid black/white.
    // A little QR contrast in the periphery survives preview downsampling without
    // reversing the image: dark artwork remains below 128, its background above.
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
          const imageDot = luminance < 0.5;
          shade = data[module] ? (imageDot ? 0 : 160) : imageDot ? 96 : 255;
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
    return { halftone: canvas.toDataURL("image/png") };
  } catch {
    // Missing image/canvas support must not remove the usable standard code.
    return undefined;
  }
}

async function clawPixels(size: number): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(CLAW_SVG);
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
