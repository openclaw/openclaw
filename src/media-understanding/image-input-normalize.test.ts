import { RastermillUnavailableError } from "rastermill";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { ImageOptimizationLimitError } from "../media/image-optimization-error.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";

const mocks = vi.hoisted(() => ({
  resolveImageCompressionModelPolicy: vi.fn(async (): Promise<ImageCompressionModelPolicy> => ({
    maxSidePx: 32,
    preferredSidePx: 32,
  })),
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
  convertImageToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
}));

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: mocks.resolveImageCompressionModelPolicy,
}));

vi.mock("../media/media-services.js", async () => {
  const actual = await vi.importActual<typeof import("../media/media-services.js")>(
    "../media/media-services.js",
  );
  return {
    ...actual,
    convertHeicToJpeg: mocks.convertHeicToJpeg,
    convertImageToJpeg: mocks.convertImageToJpeg,
  };
});

import { readImageMetadataFromHeader } from "../media/media-services.js";
import {
  optimizeImageDescriptionInput,
  normalizeImageDescriptionInput,
} from "./image-input-normalize.js";

// Minimal ISO-BMFF ftyp box with the avif brand; real byte sniffing classifies
// this header as image/avif, mirroring the shipped HEIC test fixtures.
const AVIF_HEADER_BYTES = Buffer.from("0000000c667479706176696600000000", "hex");

afterEach(() => {
  mocks.resolveImageCompressionModelPolicy.mockClear();
  mocks.convertHeicToJpeg.mockClear();
  mocks.convertImageToJpeg.mockClear();
});

describe("image description input optimization", () => {
  it("downscales recognized images to the selected model policy", async () => {
    const result = await optimizeImageDescriptionInput({
      buffer: createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 }),
      fileName: "phone.png",
      mime: "image/png",
      cfg: {},
      provider: "vision-plugin",
      model: "vision-v1",
      agentDir: "/tmp/agent",
      maxBytes: 1024 * 1024,
    });

    expect(mocks.resolveImageCompressionModelPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "vision-plugin", model: "vision-v1" }),
    );
    expect(result.mime).toBe("image/jpeg");
    expect(result.fileName).toBe("phone.jpg");
    expect(result.buffer).not.toEqual(createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 }));
    expect(readImageMetadataFromHeader(result.buffer)).toEqual({ width: 32, height: 24 });
  });

  it("preserves provider-owned unknown formats while enforcing the effective byte cap", async () => {
    const buffer = Buffer.from("custom-provider-image");
    await expect(
      optimizeImageDescriptionInput({
        buffer,
        mime: "image/x-custom",
        provider: "vision-plugin",
        model: "vision-v1",
        maxBytes: buffer.length,
      }),
    ).resolves.toEqual({ buffer, fileName: undefined, mime: "image/x-custom" });

    mocks.resolveImageCompressionModelPolicy.mockResolvedValueOnce({ maxBytes: buffer.length - 1 });
    await expect(
      optimizeImageDescriptionInput({
        buffer,
        mime: "image/x-custom",
        provider: "vision-plugin",
        model: "vision-v1",
        maxBytes: buffer.length,
      }),
    ).rejects.toMatchObject({
      name: ImageOptimizationLimitError.name,
      maxBytes: buffer.length - 1,
    });
    expect(mocks.resolveImageCompressionModelPolicy).toHaveBeenCalledTimes(2);
  });
});

describe("image description input normalization", () => {
  it("converts AVIF inputs matched only by filename when the MIME is absent", async () => {
    await expect(
      normalizeImageDescriptionInput({
        buffer: AVIF_HEADER_BYTES,
        fileName: "photo.avif",
      }),
    ).resolves.toEqual({ buffer: Buffer.from("jpeg-normalized"), mime: "image/jpeg" });
    expect(mocks.convertImageToJpeg).toHaveBeenCalledTimes(1);
  });

  it("reports an actionable decoder requirement when conversion cannot run", async () => {
    const unavailable = new RastermillUnavailableError(
      "encode",
      "Image processor unavailable for jpeg encoding; tried: photon, imagemagick, graphicsmagick, ffmpeg",
      [],
    );
    mocks.convertImageToJpeg.mockRejectedValueOnce(unavailable);
    const failure = await normalizeImageDescriptionInput({
      buffer: AVIF_HEADER_BYTES,
      fileName: "photo.avif",
      mime: "image/avif",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("image/avif");
    expect(message).toMatch(/ffmpeg|ImageMagick/u);
    expect(message).toMatch(/JPEG\/PNG\/WebP/u);
    expect((failure as Error).cause).toBe(unavailable);
  });

  it("passes common images through unchanged", async () => {
    const buffer = createSolidPngBuffer(64, 48, { r: 24, g: 96, b: 208 });
    await expect(
      normalizeImageDescriptionInput({ buffer, fileName: "photo.png", mime: "image/png" }),
    ).resolves.toEqual({ buffer, mime: "image/png" });
    expect(mocks.convertImageToJpeg).not.toHaveBeenCalled();
    expect(mocks.convertHeicToJpeg).not.toHaveBeenCalled();
  });
});
