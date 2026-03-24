import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCachedMediaMarker, cacheMediaToDisk, mediaCacheKind } from "./media-cache.js";

// Mock resolveConfigDir to use a temp directory
const tmpDir = path.join(import.meta.dirname ?? __dirname, ".tmp-media-cache-test");
vi.mock("../utils.js", () => ({
  resolveConfigDir: () => tmpDir,
}));

describe("media-cache", () => {
  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("cacheMediaToDisk", () => {
    // 1x1 red PNG pixel
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    it("writes a cached file and returns the path and hash", async () => {
      const result = await cacheMediaToDisk(PNG_BASE64, "image/png");

      expect(result.hash).toHaveLength(16);
      expect(result.path).toContain("media/cache/");
      expect(result.path).toMatch(/\.png$/);

      const stat = await fs.stat(result.path);
      expect(stat.isFile()).toBe(true);
    });

    it("deduplicates identical content", async () => {
      const first = await cacheMediaToDisk(PNG_BASE64, "image/png");
      const firstStat = await fs.stat(first.path);

      const second = await cacheMediaToDisk(PNG_BASE64, "image/png");
      const secondStat = await fs.stat(second.path);

      expect(second.path).toBe(first.path);
      expect(second.hash).toBe(first.hash);
      // mtime should be the same (file not rewritten)
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    });

    it("produces different files for different content", async () => {
      const result1 = await cacheMediaToDisk(PNG_BASE64, "image/png");
      const result2 = await cacheMediaToDisk(
        Buffer.from("different content").toString("base64"),
        "image/jpeg",
      );

      expect(result1.hash).not.toBe(result2.hash);
      expect(result1.path).not.toBe(result2.path);
    });

    it("uses correct extension for MIME types", async () => {
      const jpeg = await cacheMediaToDisk(PNG_BASE64, "image/jpeg");
      expect(jpeg.path).toMatch(/\.jpg$/);

      const ogg = await cacheMediaToDisk(Buffer.from("fake ogg").toString("base64"), "audio/ogg");
      expect(ogg.path).toMatch(/\.ogg$/);
    });

    it("creates the cache directory if missing", async () => {
      const cacheDir = path.join(tmpDir, "media", "cache");
      // Ensure it doesn't exist
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});

      const result = await cacheMediaToDisk(PNG_BASE64, "image/png");
      expect(result.path).toContain("cache/");

      const stat = await fs.stat(result.path);
      expect(stat.isFile()).toBe(true);
    });
  });

  describe("buildCachedMediaMarker", () => {
    it("produces the correct format for image", () => {
      const marker = buildCachedMediaMarker(
        "/home/.openclaw/media/cache/abc123.jpg",
        "image/jpeg",
        "image",
      );
      expect(marker).toBe(
        "[media cached: /home/.openclaw/media/cache/abc123.jpg (image/jpeg) kind=image]",
      );
    });

    it("produces the correct format for audio", () => {
      const marker = buildCachedMediaMarker(
        "/home/.openclaw/media/cache/def456.ogg",
        "audio/ogg",
        "audio",
      );
      expect(marker).toBe(
        "[media cached: /home/.openclaw/media/cache/def456.ogg (audio/ogg) kind=audio]",
      );
    });

    it("produces the correct format for document", () => {
      const marker = buildCachedMediaMarker(
        "/home/.openclaw/media/cache/ghi789.pdf",
        "application/pdf",
        "document",
      );
      expect(marker).toBe(
        "[media cached: /home/.openclaw/media/cache/ghi789.pdf (application/pdf) kind=document]",
      );
    });
  });

  describe("mediaCacheKind", () => {
    it("returns image for image MIME types", () => {
      expect(mediaCacheKind("image/jpeg")).toBe("image");
      expect(mediaCacheKind("image/png")).toBe("image");
    });

    it("returns audio for audio MIME types", () => {
      expect(mediaCacheKind("audio/ogg")).toBe("audio");
      expect(mediaCacheKind("audio/mpeg")).toBe("audio");
    });

    it("returns video for video MIME types", () => {
      expect(mediaCacheKind("video/mp4")).toBe("video");
    });

    it("returns document for unknown MIME types", () => {
      expect(mediaCacheKind("application/pdf")).toBe("document");
      expect(mediaCacheKind("text/plain")).toBe("document");
    });
  });
});
