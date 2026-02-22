import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { MediaAttachmentCache } from "./attachments.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("normalizes chatType", () => {
    expect(normalizeMediaUnderstandingChatType("channel")).toBe("channel");
    expect(normalizeMediaUnderstandingChatType("dm")).toBe("direct");
    expect(normalizeMediaUnderstandingChatType("room")).toBeUndefined();
  });

  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as Parameters<typeof resolveMediaUnderstandingScope>[0]["scope"];

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});

const originalFetch = globalThis.fetch;

async function withTempRoot<T>(prefix: string, run: (base: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

describe("media understanding attachments SSRF", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("blocks private IP URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = withFetchPreconnect(fetchSpy);

    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/secret.jpg" }]);

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads local attachments inside configured roots", async () => {
    await withTempRoot("openclaw-media-cache-allowed-", async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });

      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("ok");
    });
  });

  it("blocks local attachments outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const cache = new MediaAttachmentCache([{ index: 0, path: "/etc/passwd" }], {
      localPathRoots: ["/Users/*/Library/Messages/Attachments"],
    });

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/has no path or URL/i);
  });

  it("blocks directory attachments even inside configured roots", async () => {
    await withTempRoot("openclaw-media-cache-dir-", async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "nested");
      await fs.mkdir(attachmentPath, { recursive: true });

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/has no path or URL/i);
    });
  });

  it("blocks symlink escapes that resolve outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempRoot("openclaw-media-cache-symlink-", async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const outsidePath = "/etc/passwd";
      const symlinkPath = path.join(allowedRoot, "note.txt");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.symlink(outsidePath, symlinkPath);

      const cache = new MediaAttachmentCache([{ index: 0, path: symlinkPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/has no path or URL/i);
    });
  });
});
