import { afterEach, describe, expect, it, vi } from "vitest";

describe("image ops Rastermill adapter", () => {
  afterEach(() => {
    vi.doUnmock("rastermill");
    vi.resetModules();
  });

  it("keeps EXIF normalization best-effort when Rastermill is unavailable", async () => {
    class RastermillUnavailableError extends Error {
      readonly code = "RASTERMILL_IMAGE_PROCESSOR_UNAVAILABLE";
      readonly causes: unknown[] = [];
    }

    vi.doMock("rastermill", () => ({
      RastermillUnavailableError,
      createRastermill: () => ({
        probe: vi.fn(async () => ({
          orientation: 6,
          width: 1,
          height: 1,
          hasAlpha: false,
          format: "jpeg",
        })),
        encode: vi.fn(async () => {
          throw new RastermillUnavailableError("missing image processor");
        }),
      }),
      isRastermillUnavailableError: (error: unknown) => error instanceof RastermillUnavailableError,
      readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
      readImageProbeFromHeader: vi.fn(() => ({
        width: 1,
        height: 1,
        format: "png",
        hasAlpha: false,
        orientation: null,
      })),
    }));

    const { normalizeExifOrientation } = await import("./image-ops.js");
    const source = Buffer.from("already-safe");

    await expect(normalizeExifOrientation(source)).resolves.toBe(source);
  });

  it("falls back to encoding PNG when header alpha is unknown", async () => {
    const encode = vi.fn(async () => ({
      data: Buffer.from("encoded-png"),
      format: "png",
      width: 1,
      height: 1,
      bytes: 11,
    }));

    vi.doMock("rastermill", () => ({
      RastermillUnavailableError: class RastermillUnavailableError extends Error {},
      createRastermill: () => ({
        probe: vi.fn(async () => ({
          orientation: null,
          width: 1,
          height: 1,
          hasAlpha: null,
          format: "heif",
        })),
        encode,
      }),
      isRastermillUnavailableError: () => false,
      readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
      readImageProbeFromHeader: vi.fn(() => ({
        width: 1,
        height: 1,
        format: "png",
        hasAlpha: true,
        orientation: null,
      })),
    }));

    const { hasAlphaChannel } = await import("./image-ops.js");

    await expect(hasAlphaChannel(Buffer.from("maybe-alpha"))).resolves.toBe(true);
    expect(encode).toHaveBeenCalledWith(Buffer.from("maybe-alpha"), {
      format: "png",
      autoOrient: false,
    });
  });
});
