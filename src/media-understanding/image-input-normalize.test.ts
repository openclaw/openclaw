// Image description input normalization guards byte limits around HEIC conversion
// and optional provider-aware compression.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageCompressionPolicy } from "../media/web-media.js";
import {
  isImageDescriptionMaxBytesError,
  normalizeImageDescriptionInput,
} from "./image-input-normalize.js";

const mocks = vi.hoisted(() => ({
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
  optimizeImageBufferForWebMedia: vi.fn(async ({ buffer, contentType, fileName }) => ({
    buffer,
    contentType,
    fileName,
    kind: "image" as const,
  })),
}));

vi.mock("../media/media-services.js", () => ({
  convertHeicToJpeg: mocks.convertHeicToJpeg,
}));

vi.mock("../media/web-media.js", () => ({
  optimizeImageBufferForWebMedia: mocks.optimizeImageBufferForWebMedia,
}));

describe("normalizeImageDescriptionInput", () => {
  afterEach(() => {
    mocks.convertHeicToJpeg.mockReset();
    mocks.convertHeicToJpeg.mockResolvedValue(Buffer.from("jpeg-normalized"));
    mocks.optimizeImageBufferForWebMedia.mockReset();
    mocks.optimizeImageBufferForWebMedia.mockImplementation(
      async ({ buffer, contentType, fileName }) => ({
        buffer,
        contentType,
        fileName,
        kind: "image" as const,
      }),
    );
  });

  it("allows HEIC source bytes above the final provider cap when compression applies", async () => {
    const imageCompression = { quality: "balanced" } satisfies ImageCompressionPolicy;
    mocks.optimizeImageBufferForWebMedia.mockResolvedValue({
      buffer: Buffer.from("ok"),
      contentType: "image/jpeg",
      fileName: "photo.heic",
      kind: "image",
    });

    const result = await normalizeImageDescriptionInput({
      buffer: Buffer.from("oversized-heic"),
      fileName: "photo.heic",
      imageCompression,
      maxBytes: 8,
      mime: "image/heic",
      sourceMaxBytes: 32,
    });

    expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(Buffer.from("oversized-heic"));
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith({
      buffer: Buffer.from("jpeg-normalized"),
      contentType: "image/jpeg",
      fileName: "photo.heic",
      maxBytes: 8,
      imageCompression,
    });
    expect(result).toEqual({ buffer: Buffer.from("ok"), mime: "image/jpeg" });
  });

  it("enforces the final provider cap after HEIC compression", async () => {
    const imageCompression = { quality: "balanced" } satisfies ImageCompressionPolicy;
    mocks.optimizeImageBufferForWebMedia.mockResolvedValue({
      buffer: Buffer.from("still-large"),
      contentType: "image/jpeg",
      fileName: "photo.heic",
      kind: "image",
    });

    await expect(
      normalizeImageDescriptionInput({
        buffer: Buffer.from("oversized-heic"),
        fileName: "photo.heic",
        imageCompression,
        maxBytes: 8,
        mime: "image/heic",
        sourceMaxBytes: 32,
      }),
    ).rejects.toThrow("Image exceeds maxBytes 8");
  });

  it("wraps optimizer cap failures in an image maxBytes error", async () => {
    const imageCompression = { quality: "balanced" } satisfies ImageCompressionPolicy;
    mocks.optimizeImageBufferForWebMedia.mockRejectedValue(
      new Error("Media could not be reduced below 1MB (got 2MB)"),
    );

    let caught: unknown;
    try {
      await normalizeImageDescriptionInput({
        buffer: Buffer.from("jpeg-source"),
        fileName: "photo.jpg",
        imageCompression,
        maxBytes: 8,
        mime: "image/jpeg",
      });
    } catch (err) {
      caught = err;
    }

    expect(isImageDescriptionMaxBytesError(caught)).toBe(true);
    expect(caught).toMatchObject({ maxBytes: 8 });
  });
});
