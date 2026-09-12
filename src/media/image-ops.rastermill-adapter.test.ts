// Raster image adapter tests cover image operation integration with RasterMill.
import type { ImageProbe } from "rastermill";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("image ops Rastermill adapter", () => {
  describe("cold processor initialization", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock("rastermill");
      vi.doUnmock("@silvia-odwyer/photon-node");
      vi.doUnmock("../infra/resolve-system-bin.js");
      vi.doUnmock("../infra/worker-task-pool.js");
      vi.resetModules();
    });

    it("does not load Photon for Rastermill-backed operations", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const encode = vi.fn(async () => ({ data: Buffer.from("jpeg") }));
      const photonModuleFactory = vi.fn(() => {
        throw new Error("Photon loaded eagerly");
      });

      vi.doMock("@silvia-odwyer/photon-node", photonModuleFactory);
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill: vi.fn(() => ({ encode })),
        readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
        readImageProbeFromHeader: vi.fn(() => ({ width: 1, height: 1, format: "jpeg" })),
      }));

      const { createLocalImageProcessor } = await import("./image-processor-config.js");

      await expect(
        createLocalImageProcessor("auto").encode(Buffer.from("input"), { format: "jpeg" }),
      ).resolves.toEqual({ data: Buffer.from("jpeg") });
      expect(photonModuleFactory).not.toHaveBeenCalled();
    });

    it("configures Rastermill with OpenClaw limits, temp root, and command resolution", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const encode = vi.fn(async () => ({ data: Buffer.from("jpeg") }));
      const createRastermill = vi.fn((_options: unknown) => ({ encode }));
      const resolveSystemBin = vi.fn(() => "/usr/bin/tool");

      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill,
        readImageMetadataFromHeader: vi.fn(() => ({ width: 1, height: 1 })),
        readImageProbeFromHeader: vi.fn(() => ({ width: 1, height: 1, format: "png" })),
      }));
      vi.doMock("../infra/resolve-system-bin.js", () => ({
        resolveSystemBin,
      }));

      const { createLocalImageProcessor, MAX_IMAGE_INPUT_PIXELS } =
        await import("./image-processor-config.js");

      await expect(
        createLocalImageProcessor("auto").encode(Buffer.from("input"), { format: "jpeg" }),
      ).resolves.toEqual({ data: Buffer.from("jpeg") });

      expect(createRastermill).toHaveBeenCalledWith({
        execution: "auto",
        limits: {
          inputPixels: MAX_IMAGE_INPUT_PIXELS,
          outputPixels: MAX_IMAGE_INPUT_PIXELS,
        },
        temp: expect.objectContaining({
          prefix: "openclaw-img-",
        }),
        commandResolver: expect.any(Function),
      });
      const options = createRastermill.mock.calls[0]?.[0] as {
        commandResolver: (command: string) => string | null;
        env?: unknown;
      };
      expect(options.env).toBeUndefined();
      expect(options.commandResolver("powershell")).toBe("/usr/bin/tool");
      expect(resolveSystemBin).toHaveBeenLastCalledWith("powershell", { trust: "strict" });
    });

    it("preserves native fallback and the SDK unavailable classification when the worker declines", async () => {
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      const unavailableError = new actualRastermill.RastermillUnavailableError(
        "encode",
        "Image processor unavailable",
        [new Error("missing backend")],
      );
      const encode = vi.fn(async () => {
        throw unavailableError;
      });
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill: vi.fn(() => ({ encode })),
      }));
      vi.doMock("../infra/worker-task-pool.js", () => ({
        WorkerTaskPool: class {
          async run() {
            return {
              kind: "failed",
              unavailable: true,
              error: new Error("internal codec unavailable"),
            };
          }
        },
      }));
      const { createImageProcessor, isImageProcessorUnavailableError } =
        await import("./image-ops.js");
      const input = Buffer.from("input");
      const options = { format: "jpeg" as const };
      await expect(
        createImageProcessor()
          .encode(input, options)
          .then(
            () => false,
            (error: unknown) => isImageProcessorUnavailableError(error),
          ),
      ).resolves.toBe(true);
      expect(encode).toHaveBeenCalledWith(input, options);
    });
  });

  describe("display metadata", () => {
    const probe = vi.fn<() => Promise<ImageProbe | null>>();
    const readProbe = vi.fn<() => ImageProbe | null>();
    let imageOps: typeof import("./image-ops.js");

    beforeAll(async () => {
      vi.resetModules();
      const actualRastermill = await vi.importActual<typeof import("rastermill")>("rastermill");
      vi.doMock("rastermill", () => ({
        ...actualRastermill,
        createRastermill: vi.fn(() => ({ probe })),
        readImageProbeFromHeader: readProbe,
      }));
      imageOps = await import("./image-ops.js");
    });

    beforeEach(() => {
      probe.mockReset();
      readProbe.mockReset();
    });

    afterAll(() => {
      vi.doUnmock("rastermill");
      vi.resetModules();
    });

    it.each([
      { orientation: null, expected: { width: 640, height: 480 } },
      { orientation: 1, expected: { width: 640, height: 480 } },
      { orientation: 4, expected: { width: 640, height: 480 } },
      { orientation: 5, expected: { width: 480, height: 640 } },
      { orientation: 6, expected: { width: 480, height: 640 } },
      { orientation: 7, expected: { width: 480, height: 640 } },
      { orientation: 8, expected: { width: 480, height: 640 } },
    ] as const)(
      "reports display dimensions for EXIF orientation $orientation",
      async (testCase) => {
        const imageProbe = {
          width: 640,
          height: 480,
          format: "jpeg" as const,
          hasAlpha: false,
          orientation: testCase.orientation,
          bytes: 24,
        };
        probe.mockResolvedValue(imageProbe);
        readProbe.mockReturnValue(imageProbe);
        const image = Buffer.from("image");

        expect(imageOps.readImageMetadataFromHeader(image)).toEqual(testCase.expected);
        await expect(imageOps.getImageMetadata(image)).resolves.toEqual(testCase.expected);
        expect(imageOps.readImageProbeFromHeader(image)).toEqual(imageProbe);
      },
    );
  });
});
