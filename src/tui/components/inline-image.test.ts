import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIME_BY_EXT,
  _resetCapabilityCache,
  canRenderInlineImages,
  createInlineImage,
  isSupportedImageExt,
  readMediaImageAsBase64,
} from "./inline-image.js";

// Minimal valid 1x1 PNG (67 bytes)
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_BUF = Buffer.from(TINY_PNG_B64, "base64");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `inline-image-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  _resetCapabilityCache();
});

describe("canRenderInlineImages", () => {
  it("returns a boolean", () => {
    // In test environment, terminal typically has no image support
    expect(typeof canRenderInlineImages()).toBe("boolean");
  });

  it("caches the result across calls", () => {
    const first = canRenderInlineImages();
    const second = canRenderInlineImages();
    expect(first).toBe(second);
  });
});

describe("readMediaImageAsBase64", () => {
  it("reads a valid PNG file", () => {
    const filePath = join(testDir, "test.png");
    writeFileSync(filePath, TINY_PNG_BUF);
    const result = readMediaImageAsBase64(filePath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/png");
    expect(result!.data).toBe(TINY_PNG_B64);
  });

  it("reads a valid JPEG file", () => {
    const filePath = join(testDir, "test.jpg");
    writeFileSync(filePath, TINY_PNG_BUF); // contents don't matter for MIME check
    const result = readMediaImageAsBase64(filePath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/jpeg");
  });

  it("reads a .webp file", () => {
    const filePath = join(testDir, "test.webp");
    writeFileSync(filePath, TINY_PNG_BUF);
    const result = readMediaImageAsBase64(filePath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/webp");
  });

  it("returns null for non-existent file", () => {
    expect(readMediaImageAsBase64(join(testDir, "nope.png"))).toBeNull();
  });

  it("returns null for non-image extension", () => {
    const filePath = join(testDir, "data.json");
    writeFileSync(filePath, "{}");
    expect(readMediaImageAsBase64(filePath)).toBeNull();
  });

  it("returns null for .txt extension", () => {
    const filePath = join(testDir, "notes.txt");
    writeFileSync(filePath, "hello");
    expect(readMediaImageAsBase64(filePath)).toBeNull();
  });

  it("returns null for relative path", () => {
    const filePath = join(testDir, "test.png");
    writeFileSync(filePath, TINY_PNG_BUF);
    expect(readMediaImageAsBase64("./test.png")).toBeNull();
  });

  it("normalizes paths with .. segments before reading", () => {
    // Path with .. segments should be normalized and succeed if the
    // resolved file is a valid image. This is a local TUI reading local
    // files, so normalization is sufficient defense-in-depth.
    const subdir = join(testDir, "subdir");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(testDir, "test.png"), TINY_PNG_BUF);
    const traversalPath = `${subdir}/../test.png`;
    const result = readMediaImageAsBase64(traversalPath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/png");
  });

  it("returns null for empty string", () => {
    expect(readMediaImageAsBase64("")).toBeNull();
  });

  it("returns null for path with null byte", () => {
    expect(readMediaImageAsBase64("/tmp/evil\0.png")).toBeNull();
  });

  it("returns null for empty file", () => {
    const filePath = join(testDir, "empty.png");
    writeFileSync(filePath, "");
    expect(readMediaImageAsBase64(filePath)).toBeNull();
  });

  it("returns null for oversized file", () => {
    const filePath = join(testDir, "big.png");
    // Write a file just over 6MB
    writeFileSync(filePath, Buffer.alloc(6 * 1024 * 1024 + 1));
    expect(readMediaImageAsBase64(filePath)).toBeNull();
  });

  it("returns null for symlinks", () => {
    const realPath = join(testDir, "real.png");
    const linkPath = join(testDir, "link.png");
    writeFileSync(realPath, TINY_PNG_BUF);
    try {
      symlinkSync(realPath, linkPath);
    } catch {
      // Symlinks may require elevated privileges on Windows, skip
      return;
    }
    expect(readMediaImageAsBase64(linkPath)).toBeNull();
  });

  it("returns null for directory path", () => {
    const dirPath = join(testDir, "subdir.png");
    mkdirSync(dirPath, { recursive: true });
    expect(readMediaImageAsBase64(dirPath)).toBeNull();
  });
});

describe("createInlineImage", () => {
  it("returns an Image component", () => {
    const image = createInlineImage(TINY_PNG_B64, "image/png");
    expect(image).toBeDefined();
    expect(typeof image.render).toBe("function");
  });

  it("accepts optional filename", () => {
    const image = createInlineImage(TINY_PNG_B64, "image/png", {
      filename: "chart.png",
    });
    expect(image).toBeDefined();
  });

  it("accepts custom maxWidthCells", () => {
    const image = createInlineImage(TINY_PNG_B64, "image/png", {
      maxWidthCells: 40,
    });
    expect(image).toBeDefined();
  });
});

describe("MIME_BY_EXT", () => {
  it("maps all standard image extensions", () => {
    expect(MIME_BY_EXT[".png"]).toBe("image/png");
    expect(MIME_BY_EXT[".jpg"]).toBe("image/jpeg");
    expect(MIME_BY_EXT[".jpeg"]).toBe("image/jpeg");
    expect(MIME_BY_EXT[".gif"]).toBe("image/gif");
    expect(MIME_BY_EXT[".webp"]).toBe("image/webp");
  });

  it("does not include non-image types", () => {
    expect(MIME_BY_EXT[".txt"]).toBeUndefined();
    expect(MIME_BY_EXT[".json"]).toBeUndefined();
    expect(MIME_BY_EXT[".pdf"]).toBeUndefined();
  });
});

describe("isSupportedImageExt", () => {
  it("accepts supported extensions", () => {
    expect(isSupportedImageExt(".png")).toBe(true);
    expect(isSupportedImageExt(".jpg")).toBe(true);
    expect(isSupportedImageExt(".jpeg")).toBe(true);
    expect(isSupportedImageExt(".gif")).toBe(true);
    expect(isSupportedImageExt(".webp")).toBe(true);
  });

  it("rejects unsupported extensions", () => {
    expect(isSupportedImageExt(".txt")).toBe(false);
    expect(isSupportedImageExt(".pdf")).toBe(false);
    expect(isSupportedImageExt(".svg")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isSupportedImageExt(".PNG")).toBe(true);
    expect(isSupportedImageExt(".Jpg")).toBe(true);
  });
});
