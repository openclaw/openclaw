import qrcode from "qrcode";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicShareQr } from "./public-share-qr.ts";

const url =
  "https://team.openclaw.ai/chat/roboclaw/recognizable-halftone-lobster-619dfdde5f1b4f7fbe9c68ab72f812f8";
afterEach(() => vi.restoreAllMocks());

it("keeps function marks, centers and quiet zone exact while the surrounding cells carry the image", async () => {
  const qr = await createPublicShareQr(url);
  const image = new Image();
  image.src = qr!.halftone;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = image.width;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const { modules } = qrcode.create(url, { errorCorrectionLevel: "H" });
  expect(image.width).toBe((modules.size + 8) * 9);
  let incorrect = 0;
  let imageLed = 0;
  const notch: boolean[] = [];
  const wrist: boolean[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const shade = pixels[(y * image.width + x) * 4];
      if (x < 36 || y < 36 || x >= image.width - 36 || y >= image.width - 36) {
        if (shade !== 255) {
          incorrect++;
        }
        continue;
      }
      const sx = Math.floor((x - 36) / 3);
      const sy = Math.floor((y - 36) / 3);
      const index = Math.floor(sy / 3) * modules.size + Math.floor(sx / 3);
      const bit = Boolean(modules.data[index]);
      if (modules.reservedBit[index] || (sx % 3 === 1 && sy % 3 === 1)) {
        if (shade !== (bit ? 0 : 255)) {
          incorrect++;
        }
      } else {
        const dark = shade! < 128;
        if (dark !== bit) {
          imageLed++;
        }
        const u = (sx / (modules.size * 3) - 0.08) / 0.84;
        const v = (sy / (modules.size * 3) - 0.08) / 0.84;
        if (u > 0.55 && u < 0.65 && v > 0.25 && v < 0.3) {
          notch.push(dark);
        }
        if (u > 0.25 && u < 0.3 && v > 0.8 && v < 0.84) {
          wrist.push(dark);
        }
      }
    }
  }
  // Recover the artwork from eligible peripheral cells, not the overlaid QR bits.
  // A single pincer has an open notch and a lower-left wrist, unlike the full mascot.
  expect(notch.filter(Boolean).length / notch.length).toBeLessThan(0.1);
  expect(wrist.filter(Boolean).length / wrist.length).toBeGreaterThan(0.9);
  expect(incorrect).toBe(0);
  // The previous 0–64/192–255 periphery never crossed a QR bit's threshold,
  // so its almost invisible artwork could pass a mere "pixels changed" test.
  expect(imageLed).toBeGreaterThan((image.width * image.height) / 5);
});

it("leaves the standard renderer available when artwork cannot load", async () => {
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(new Error("Image unavailable"));
  expect(await createPublicShareQr(url)).toBeUndefined();
});
