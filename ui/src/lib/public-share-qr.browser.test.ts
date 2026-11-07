import qrcode from "qrcode";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicShareQr } from "./public-share-qr.ts";

const url = "https://example.com/chat/openclaw/halftone-demo";

afterEach(() => vi.restoreAllMocks());

async function pixels(dataUrl: string) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = image.width;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width };
}

it("keeps every function module and data-module centre exact, with a four-module quiet zone", async () => {
  const qr = await createPublicShareQr(url);
  expect(qr.halftone).toBeDefined();
  const styled = await pixels(qr.halftone!);
  const plain = await pixels(qr.plain);
  const { modules } = qrcode.create(url, { errorCorrectionLevel: "H" });
  expect(styled.width).toBe((modules.size + 8) * 9);
  let incorrect = 0;
  let changedImageCells = 0;
  for (let y = 0; y < styled.width; y++) {
    for (let x = 0; x < styled.width; x++) {
      const pixel = (y * styled.width + x) * 4;
      if (x < 36 || y < 36 || x >= styled.width - 36 || y >= styled.width - 36) {
        if (styled.data[pixel] !== 255) {
          incorrect++;
        }
        continue;
      }
      const sx = Math.floor((x - 36) / 3);
      const sy = Math.floor((y - 36) / 3);
      const module = Math.floor(sy / 3) * modules.size + Math.floor(sx / 3);
      if (modules.reservedBit[module] || (sx % 3 === 1 && sy % 3 === 1)) {
        if (styled.data[pixel] !== (modules.data[module] ? 0 : 255)) {
          incorrect++;
        }
      } else {
        if (modules.data[module] ? styled.data[pixel]! > 64 : styled.data[pixel]! < 192) {
          incorrect++;
        }
        if (styled.data[pixel] !== plain.data[pixel]) {
          changedImageCells++;
        }
      }
    }
  }
  expect(incorrect).toBe(0);
  expect(changedImageCells).toBeGreaterThan(0);
});

it("keeps a standard QR when the link is dense or artwork cannot load", async () => {
  const dense = await createPublicShareQr("https://example.com/chat/openclaw/" + "x".repeat(150));
  expect(dense.halftone).toBeUndefined();
  expect(dense.plain.startsWith("data:image/png;base64,")).toBe(true);
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(new Error("Image unavailable"));
  const fallback = await createPublicShareQr(url);
  expect(fallback.halftone).toBeUndefined();
  expect(fallback.plain.startsWith("data:image/png;base64,")).toBe(true);
});
