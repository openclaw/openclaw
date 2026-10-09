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

  it.each([3, 20_000])("bounds a %i-byte unscaled fallback", async (bytes) => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));
    const result = await fileToAvatarDataUrl(
      new File([new Uint8Array(bytes)], "avatar.png", { type: "image/png" }),
    );
    if (bytes === 3) {
      expect(result.ok && result.dataUrl).toMatch(/^data:image\/png;base64,/u);
    } else {
      expect(result).toEqual({ ok: false, reason: "too-detailed" });
    }
  });

  it("rejects non-image files as unusable", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(fileToAvatarDataUrl(file)).resolves.toEqual({ ok: false, reason: "unusable" });
  });

  it.each([
    ["WebP", false, 1_000, true, "webp"],
    ["opaque JPEG fallback", true, 1_000, false, "jpeg"],
    ["transparent PNG downscaling", false, 300, false, "png"],
    ["oversized PNG fallback", false, 1_000, false, null],
  ] as const)(
    "bounds %s without flattening transparency",
    async (_, opaque, density, webp, mime) => {
      const encodings = stubCanvas({ opaque, pngCharsPerEdgePixel: density, webp });
      const result = await fileToAvatarDataUrl(pngFile());
      if (mime === null) {
        expect(result).toEqual({ ok: false, reason: "too-detailed" });
      } else {
        expect(result.ok && result.dataUrl).toMatch(new RegExp(`^data:image/${mime};base64,`, "u"));
      }
      if (mime === "png") {
        // 96px and 64px exceed the identity budget; 48px fits without losing alpha.
        expect(encodings.some((encoding) => encoding.mime === "image/jpeg")).toBe(false);
        expect(encodings.at(-1)).toEqual({ mime: "image/png", width: 48 });
      }
    },
  );
});
