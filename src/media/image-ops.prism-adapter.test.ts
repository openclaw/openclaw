import { afterEach, describe, expect, it, vi } from "vitest";

describe("image ops Prism adapter", () => {
  afterEach(() => {
    vi.doUnmock("@openclaw/prism");
    vi.resetModules();
  });

  it("keeps EXIF normalization best-effort when Prism is unavailable", async () => {
    class PrismUnavailableError extends Error {
      readonly code = "PRISM_IMAGE_PROCESSOR_UNAVAILABLE";
      readonly causes: unknown[] = [];
    }

    vi.doMock("@openclaw/prism", () => ({
      PrismUnavailableError,
      createPrism: () => ({
        normalize: vi.fn(async () => {
          throw new PrismUnavailableError("missing image processor");
        }),
      }),
      isPrismUnavailableError: (error: unknown) => error instanceof PrismUnavailableError,
      readImageMetadataFromHeader: vi.fn(() => null),
    }));

    const { normalizeExifOrientation } = await import("./image-ops.js");
    const source = Buffer.from("already-safe");

    await expect(normalizeExifOrientation(source)).resolves.toBe(source);
  });
});
