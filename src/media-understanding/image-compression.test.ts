// Covers media-understanding image compression without provider execution.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

const mocks = vi.hoisted(() => ({
  optimizeImageBufferForWebMedia: vi.fn(
    async (params: { buffer: Buffer; contentType?: string }) => ({
      buffer: params.buffer,
      contentType: params.contentType ?? "image/jpeg",
      kind: "image" as const,
    }),
  ),
}));

vi.mock("../media/web-media.js", () => ({
  optimizeImageBufferForWebMedia: mocks.optimizeImageBufferForWebMedia,
}));

const { compressImageForDescription } = await import("./image-compression.js");

describe("compressImageForDescription", () => {
  afterEach(() => {
    mocks.optimizeImageBufferForWebMedia.mockClear();
  });

  it("resizes image when imageMaxDimensionPx is configured", async () => {
    const buffer = Buffer.alloc(1024);
    await compressImageForDescription({
      buffer,
      mime: "image/jpeg",
      cfg: { agents: { defaults: { imageMaxDimensionPx: 1200 } } } as OpenClawConfig,
    });
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCompression: { models: [{ maxSidePx: 1200 }] },
      }),
    );
  });

  it("includes quality when imageQuality is configured", async () => {
    const buffer = Buffer.alloc(1024);
    await compressImageForDescription({
      buffer,
      mime: "image/jpeg",
      cfg: { agents: { defaults: { imageQuality: "high" } } } as OpenClawConfig,
    });
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCompression: { quality: "high" },
      }),
    );
  });

  it("combines dimension and quality when both are configured", async () => {
    const buffer = Buffer.alloc(1024);
    await compressImageForDescription({
      buffer,
      mime: "image/png",
      cfg: {
        agents: { defaults: { imageMaxDimensionPx: 800, imageQuality: "balanced" } },
      } as OpenClawConfig,
    });
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCompression: { quality: "balanced", models: [{ maxSidePx: 800 }] },
      }),
    );
  });

  it("returns buffer unchanged when neither dimension nor quality is configured", async () => {
    const buffer = Buffer.from("test-data");
    const result = await compressImageForDescription({ buffer, mime: "image/jpeg" });
    expect(result.buffer).toBe(buffer);
    expect(result.mime).toBe("image/jpeg");
    expect(mocks.optimizeImageBufferForWebMedia).not.toHaveBeenCalled();
  });

  it("returns buffer unchanged when imageMaxDimensionPx is NaN", async () => {
    const buffer = Buffer.from("test-data");
    const result = await compressImageForDescription({
      buffer,
      mime: "image/jpeg",
      cfg: { agents: { defaults: { imageMaxDimensionPx: Number.NaN } } } as OpenClawConfig,
    });
    expect(result.buffer).toBe(buffer);
    expect(mocks.optimizeImageBufferForWebMedia).not.toHaveBeenCalled();
  });

  it("returns buffer unchanged when imageMaxDimensionPx is Infinity", async () => {
    const buffer = Buffer.from("test-data");
    const result = await compressImageForDescription({
      buffer,
      mime: "image/jpeg",
      cfg: { agents: { defaults: { imageMaxDimensionPx: Infinity } } } as OpenClawConfig,
    });
    expect(result.buffer).toBe(buffer);
    expect(mocks.optimizeImageBufferForWebMedia).not.toHaveBeenCalled();
  });

  it("clamps negative imageMaxDimensionPx to 1", async () => {
    const buffer = Buffer.alloc(1024);
    await compressImageForDescription({
      buffer,
      mime: "image/jpeg",
      cfg: { agents: { defaults: { imageMaxDimensionPx: -5 } } } as OpenClawConfig,
    });
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCompression: { models: [{ maxSidePx: 1 }] },
      }),
    );
  });

  it("floors fractional imageMaxDimensionPx", async () => {
    const buffer = Buffer.alloc(1024);
    await compressImageForDescription({
      buffer,
      mime: "image/jpeg",
      cfg: { agents: { defaults: { imageMaxDimensionPx: 1200.7 } } } as OpenClawConfig,
    });
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCompression: { models: [{ maxSidePx: 1200 }] },
      }),
    );
  });

  it("passes through mime, fileName, maxBytes to optimizeImageBufferForWebMedia", async () => {
    const buffer = Buffer.alloc(1024);
    await compressImageForDescription({
      buffer,
      mime: "image/webp",
      fileName: "photo.webp",
      maxBytes: 5 * 1024 * 1024,
      cfg: { agents: { defaults: { imageMaxDimensionPx: 800 } } } as OpenClawConfig,
    });
    expect(mocks.optimizeImageBufferForWebMedia).toHaveBeenCalledWith({
      buffer,
      contentType: "image/webp",
      fileName: "photo.webp",
      maxBytes: 5 * 1024 * 1024,
      imageCompression: { models: [{ maxSidePx: 800 }] },
    });
  });
});
