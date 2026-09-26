/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fileToAvatarDataUrl } from "./avatar-image.ts";

const pngFile = () => new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" });

/** Fakes a canvas whose encoder ignores WebP unless `webp` is set (WebKit
    ignores it) and whose PNG output length scales with the canvas edge, like
    detailed artwork. */
function stubCanvas(options: { opaque: boolean; pngCharsPerEdgePixel: number; webp?: boolean }) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 512, height: 512, close: vi.fn() }),
  );
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(options.opaque ? 255 : 0),
    })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const encodings: Array<{ mime: string; width: number }> = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
    this: HTMLCanvasElement,
    type?: string,
  ) {
    if (options.webp && type === "image/webp") {
      return `data:image/webp;base64,${"A".repeat(4_000)}`;
    }
    const mime = type === "image/jpeg" ? "image/jpeg" : "image/png";
    encodings.push({ mime, width: this.width });
    const payloadLength = mime === "image/jpeg" ? 4_000 : this.width * options.pngCharsPerEdgePixel;
    return `data:${mime};base64,${"A".repeat(payloadLength)}`;
  });
  return encodings;
}

describe("fileToAvatarDataUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports unscaled fallback encodings over the identity budget as too detailed", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));
    const file = new File([new Uint8Array(20_000)], "avatar.png", { type: "image/png" });

    await expect(fileToAvatarDataUrl(file)).resolves.toEqual({
      ok: false,
      reason: "too-detailed",
    });
  });

  it("keeps small fallback encodings", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));

    const result = await fileToAvatarDataUrl(pngFile());

    expect(result.ok && result.dataUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it("keeps WebP encodings when the canvas supports them", async () => {
    stubCanvas({ opaque: false, pngCharsPerEdgePixel: 1_000, webp: true });

    const result = await fileToAvatarDataUrl(pngFile());

    expect(result.ok && result.dataUrl).toMatch(/^data:image\/webp;base64,/u);
  });

  it("rejects non-image files as unusable", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(fileToAvatarDataUrl(file)).resolves.toEqual({ ok: false, reason: "unusable" });
  });

  it("steps transparent images down in size when only PNG encoding is available", async () => {
    // 96px and 64px PNGs exceed the 16K budget at this density; 48px fits.
    const encodings = stubCanvas({ opaque: false, pngCharsPerEdgePixel: 300 });

    const result = await fileToAvatarDataUrl(pngFile());

    expect(result.ok && result.dataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(encodings.some(({ mime }) => mime === "image/jpeg")).toBe(false);
    expect(encodings.at(-1)).toEqual({ mime: "image/png", width: 48 });
  });

  it("uses JPEG for opaque images when WebP encoding is unavailable", async () => {
    stubCanvas({ opaque: true, pngCharsPerEdgePixel: 1_000 });

    const result = await fileToAvatarDataUrl(pngFile());

    expect(result.ok && result.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
  });

  it("reports images that stay too large at every fallback size as too detailed", async () => {
    stubCanvas({ opaque: false, pngCharsPerEdgePixel: 1_000 });

    await expect(fileToAvatarDataUrl(pngFile())).resolves.toEqual({
      ok: false,
      reason: "too-detailed",
    });
  });
});
