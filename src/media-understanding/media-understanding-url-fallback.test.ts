import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { MediaAttachmentCache } from "./attachments.js";

const originalFetch = globalThis.fetch;

describe("media understanding attachment URL fallback", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("getPath falls back to URL fetch when local path is blocked", async () => {
    await withTempDir({ prefix: "openclaw-media-cache-getpath-url-fallback-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
      const fallbackUrl = "https://example.com/fallback.jpg";
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: attachmentPath, url: fallbackUrl, mime: "image/jpeg" }],
        {
          localPathRoots: [allowedRoot],
        },
      );
      const originalRealpath = fs.realpath.bind(fs);
      const fetchSpy = vi.fn(
        async () =>
          new Response(Buffer.from("fallback-buffer"), {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
            },
          }),
      );

      globalThis.fetch = withFetchPreconnect(fetchSpy);
      vi.spyOn(fs, "realpath").mockImplementation(async (candidatePath) => {
        if (String(candidatePath) === attachmentPath) {
          throw new Error("EACCES");
        }
        return await originalRealpath(candidatePath);
      });

      const result = await cache.getPath({
        attachmentIndex: 0,
        maxBytes: 1024,
        timeoutMs: 1000,
      });
      // getPath should fall through to getBuffer URL fetch, write a temp file,
      // and return a path to that temp file instead of throwing.
      expect(result.path).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(fallbackUrl, expect.anything());
      // Clean up the temp file
      if (result.cleanup) {
        await result.cleanup();
      }
    });
  });

  it("falls back to URL fetch when local attachment canonicalization fails", async () => {
    await withTempDir({ prefix: "openclaw-media-cache-url-fallback-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
      const fallbackUrl = "https://example.com/fallback.jpg";
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: attachmentPath, url: fallbackUrl, mime: "image/jpeg" }],
        {
          localPathRoots: [allowedRoot],
        },
      );
      const originalRealpath = fs.realpath.bind(fs);
      const fetchSpy = vi.fn(
        async () =>
          new Response(Buffer.from("fallback-buffer"), {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
            },
          }),
      );

      globalThis.fetch = withFetchPreconnect(fetchSpy);
      vi.spyOn(fs, "realpath").mockImplementation(async (candidatePath) => {
        if (String(candidatePath) === attachmentPath) {
          throw new Error("EACCES");
        }
        return await originalRealpath(candidatePath);
      });

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: 1024,
        timeoutMs: 1000,
      });
      expect(result.buffer.toString()).toBe("fallback-buffer");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(fallbackUrl, expect.anything());
    });
  });
});
