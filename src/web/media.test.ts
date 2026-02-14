import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { optimizeImageToPng } from "../media/image-ops.js";
import { loadWebMedia, loadWebMediaRaw, optimizeImageToJpeg } from "./media.js";

let fixtureRoot = "";
let fixtureFileCount = 0;
let largeJpegBuffer: Buffer;
let tinyPngBuffer: Buffer;

async function writeTempFile(buffer: Buffer, ext: string): Promise<string> {
  const file = path.join(fixtureRoot, `media-${fixtureFileCount++}${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}

function buildDeterministicBytes(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let seed = 0x12345678;
  for (let i = 0; i < length; i++) {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    buffer[i] = seed & 0xff;
  }
  return buffer;
}

async function createLargeTestJpeg(): Promise<{ buffer: Buffer; file: string }> {
  const file = await writeTempFile(largeJpegBuffer, ".jpg");
  return { buffer: largeJpegBuffer, file };
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-test-"));
  largeJpegBuffer = await sharp({
    create: {
      width: 1200,
      height: 1200,
      channels: 3,
      background: "#ff0000",
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  tinyPngBuffer = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#00ff00" },
  })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("web media loading", () => {
  beforeAll(() => {
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(async (hostname) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      const addresses = ["93.184.216.34"];
      return {
        hostname: normalized,
        addresses,
        lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
      };
    });
  });

  it("compresses large local images under the provided cap", async () => {
    const { buffer, file } = await createLargeTestJpeg();

    const cap = Math.floor(buffer.length * 0.8);
    const result = await loadWebMedia(file, cap);

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(buffer.length);
  });

  it("optimizes images when options object omits optimizeImages", async () => {
    const { buffer, file } = await createLargeTestJpeg();
    const cap = Math.max(1, Math.floor(buffer.length * 0.8));

    const result = await loadWebMedia(file, { maxBytes: cap });

    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(buffer.length);
  });

  it("allows callers to disable optimization via options object", async () => {
    const { buffer, file } = await createLargeTestJpeg();
    const cap = Math.max(1, Math.floor(buffer.length * 0.8));

    await expect(loadWebMedia(file, { maxBytes: cap, optimizeImages: false })).rejects.toThrow(
      /Media exceeds/i,
    );
  });

  it("sniffs mime before extension when loading local files", async () => {
    const wrongExt = await writeTempFile(tinyPngBuffer, ".bin");

    const result = await loadWebMedia(wrongExt, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("adds extension to URL fileName when missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200,
    } as Response);

    const result = await loadWebMedia("https://example.com/download", 1024 * 1024);

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/pdf");
    expect(result.fileName).toBe("download.pdf");

    fetchMock.mockRestore();
  });

  it("includes URL + status in fetch errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      body: true,
      text: async () => "Not Found",
      headers: { get: () => null },
      status: 404,
      statusText: "Not Found",
      url: "https://example.com/missing.jpg",
    } as Response);

    await expect(loadWebMedia("https://example.com/missing.jpg", 1024 * 1024)).rejects.toThrow(
      /Failed to fetch media from https:\/\/example\.com\/missing\.jpg.*HTTP 404/i,
    );

    fetchMock.mockRestore();
  });

  it("respects maxBytes for raw URL fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.alloc(2048).buffer,
      headers: { get: () => "image/png" },
      status: 200,
    } as Response);

    await expect(loadWebMediaRaw("https://example.com/too-big.png", 1024)).rejects.toThrow(
      /exceeds maxBytes 1024/i,
    );

    fetchMock.mockRestore();
  });

  it("uses content-disposition filename when available", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: {
        get: (name: string) => {
          if (name === "content-disposition") {
            return 'attachment; filename="report.pdf"';
          }
          if (name === "content-type") {
            return "application/pdf";
          }
          return null;
        },
      },
      status: 200,
    } as Response);

    const result = await loadWebMedia("https://example.com/download?id=1", 1024 * 1024);

    expect(result.kind).toBe("document");
    expect(result.fileName).toBe("report.pdf");

    fetchMock.mockRestore();
  });

  it("preserves GIF animation by skipping JPEG optimization", async () => {
    // Create a minimal valid GIF (1x1 pixel)
    // GIF89a header + minimal image data
    const gifBuffer = Buffer.from([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      0x01,
      0x00,
      0x01,
      0x00, // 1x1 dimensions
      0x00,
      0x00,
      0x00, // no global color table
      0x2c,
      0x00,
      0x00,
      0x00,
      0x00, // image descriptor
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // 1x1 image
      0x02,
      0x01,
      0x44,
      0x00,
      0x3b, // minimal LZW data + trailer
    ]);

    const file = await writeTempFile(gifBuffer, ".gif");

    const result = await loadWebMedia(file, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    // GIF should NOT be converted to JPEG
    expect(result.buffer.slice(0, 3).toString()).toBe("GIF");
  });

  it("preserves GIF from URL without JPEG conversion", async () => {
    const gifBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength),
      headers: { get: () => "image/gif" },
      status: 200,
    } as Response);

    const result = await loadWebMedia("https://example.com/animation.gif", 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    expect(result.buffer.slice(0, 3).toString()).toBe("GIF");

    fetchMock.mockRestore();
  });

  it("preserves PNG alpha when under the cap", async () => {
    const buffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    const file = await writeTempFile(buffer, ".png");

    const result = await loadWebMedia(file, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it("falls back to JPEG when PNG alpha cannot fit under cap", async () => {
    const size = 96;
    const raw = buildDeterministicBytes(size * size * 4);
    const pngBuffer = await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toBuffer();
    const smallestPng = await optimizeImageToPng(pngBuffer, 1);
    const cap = Math.max(1, smallestPng.optimizedSize - 1);
    const jpegOptimized = await optimizeImageToJpeg(pngBuffer, cap);

    if (jpegOptimized.buffer.length >= smallestPng.optimizedSize) {
      throw new Error(
        `JPEG fallback did not shrink below PNG (jpeg=${jpegOptimized.buffer.length}, png=${smallestPng.optimizedSize})`,
      );
    }

    const file = await writeTempFile(pngBuffer, ".png");

    const result = await loadWebMedia(file, cap);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
  });
});

describe("local media root guard", () => {
  it("rejects local paths outside allowed roots", async () => {
    const file = await writeTempFile(tinyPngBuffer, ".png");

    // Explicit roots that don't contain the temp file.
    await expect(
      loadWebMedia(file, 1024 * 1024, { localRoots: ["/nonexistent-root"] }),
    ).rejects.toThrow(/not under an allowed directory/i);
  });

  it("allows local paths under an explicit root", async () => {
    const file = await writeTempFile(tinyPngBuffer, ".png");

    const result = await loadWebMedia(file, 1024 * 1024, { localRoots: [os.tmpdir()] });
    expect(result.kind).toBe("image");
  });

  it("allows any path when localRoots is 'any'", async () => {
    const file = await writeTempFile(tinyPngBuffer, ".png");

    const result = await loadWebMedia(file, 1024 * 1024, { localRoots: "any" });
    expect(result.kind).toBe("image");
  });
});
