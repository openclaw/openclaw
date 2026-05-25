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
        normalize: vi.fn(async () => {
          throw new RastermillUnavailableError("missing image processor");
        }),
      }),
      isRastermillUnavailableError: (error: unknown) => error instanceof RastermillUnavailableError,
      readImageMetadataFromHeader: vi.fn(() => null),
    }));

    const { normalizeExifOrientation } = await import("./image-ops.js");
    const source = Buffer.from("already-safe");

    await expect(normalizeExifOrientation(source)).resolves.toBe(source);
  });
});
