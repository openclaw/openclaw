import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { MediaAttachmentCache } from "./attachments.js";

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return {
    ...actual,
    readRemoteMediaBuffer: readRemoteMediaBufferMock,
    readRemoteMediaBufferWithHeaders: readRemoteMediaBufferMock,
  };
});

const fallbackUrl = "https://example.com/fallback.jpg";
const readOptions = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 };

async function withFallback(missing: boolean, run: (cache: MediaAttachmentCache) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-media-url-fallback-" }, async (base) => {
    const attachmentRoot = path.join(base, "attachment");
    const allowedRoot = path.join(base, "allowed");
    const attachmentPath = path.join(attachmentRoot, "voice-note.m4a");
    await fs.mkdir(attachmentRoot, { recursive: true });
    await fs.mkdir(allowedRoot, { recursive: true });
    if (!missing) {
      await fs.writeFile(attachmentPath, "ok");
    }

    const cache = new MediaAttachmentCache(
      [{ index: 0, path: attachmentPath, url: fallbackUrl, mime: "image/jpeg" }],
      missing ? undefined : { localPathRoots: [allowedRoot] },
    );
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: Buffer.from("fallback-buffer"),
      contentType: "image/jpeg",
      fileName: "fallback.jpg",
    });

    try {
      await run(cache);
    } finally {
      await cache.cleanup();
    }
  });
}

function expectFetch() {
  expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(1);
  expect(readRemoteMediaBufferMock.mock.calls[0]?.[0]).toStrictEqual({
    url: fallbackUrl,
    timeoutMs: 1000,
    maxBytes: 1024,
    ssrfPolicy: undefined,
    retry: expect.objectContaining({ attempts: 3 }),
  });
}

describe("media understanding attachment URL fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    readRemoteMediaBufferMock.mockReset();
  });

  it("getPath falls back to URL fetch when local path is blocked", async () => {
    await withFallback(false, async (cache) => {
      const result = await cache.getPath(readOptions);
      expect(path.dirname(result)).toBe(resolvePreferredOpenClawTmpDir());
      expect(path.extname(result)).toBe(".jpg");
      await expect(fs.readFile(result, "utf8")).resolves.toBe("fallback-buffer");
      expectFetch();
    });
  });

  it.each([false, true])("getBuffer falls back to URL (missing local path=%s)", async (missing) => {
    await withFallback(missing, async (cache) => {
      const result = await cache.getBuffer(readOptions);
      expect(result.buffer.toString()).toBe("fallback-buffer");
      expectFetch();
    });
  });
});
