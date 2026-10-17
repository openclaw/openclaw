import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";
import { saveMediaBuffer } from "../media/store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { MediaAttachmentCache } from "./attachments.js";
import { resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as Parameters<typeof resolveMediaUnderstandingScope>[0]["scope"];

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});

const originalFetch = globalThis.fetch;
const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

function read(cache: MediaAttachmentCache, attachmentIndex = 0) {
  return cache.getBuffer({ attachmentIndex, maxBytes: 1024, timeoutMs: 1000 });
}

async function collision(base: string, allowedCwd: boolean) {
  const stateDir = path.join(base, "state");
  const cwd = path.join(base, "cwd");
  const relativePath = "media/inbound/photo.jpg";
  for (const [root, text] of [
    [cwd, "cwd-media"],
    [stateDir, "state-media"],
  ]) {
    const file = path.join(root, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  return new MediaAttachmentCache([{ index: 0, path: relativePath }], {
    localPathRoots: (allowedCwd ? [cwd, stateDir] : [stateDir]).map((root) =>
      path.join(root, "media"),
    ),
  });
}

async function withLocalAttachmentCache(
  prefix: string,
  run: (params: {
    cache: MediaAttachmentCache;
    attachmentPath: string;
    canonicalAttachmentPath: string;
  }) => Promise<void>,
) {
  await withTestDir({ prefix }, async (base) => {
    const allowedRoot = path.join(base, "allowed");
    const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.writeFile(attachmentPath, "ok");
    const canonicalAttachmentPath = await fs.realpath(attachmentPath).catch(() => attachmentPath);

    const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
      localPathRoots: [allowedRoot],
    });

    await run({ cache, attachmentPath, canonicalAttachmentPath });
  });
}

describe("media understanding attachments SSRF", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    stateDirEnvSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("blocks private IP URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = withFetchPreconnect(fetchSpy);

    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/secret.jpg" }]);

    await expect(read(cache)).rejects.toThrow(/private|internal|blocked/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows RFC2544 benchmark-range URLs only when media fetch policy opts in", async () => {
    const url = "http://198.18.0.153/file.jpg";
    const deniedCache = new MediaAttachmentCache([{ index: 0, url }]);
    await expect(read(deniedCache)).rejects.toThrow(/private|internal|blocked/i);

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("image", {
        headers: { "content-type": "image/jpeg" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const allowedCache = new MediaAttachmentCache([{ index: 0, url }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await read(allowedCache);
    expect(result).toStrictEqual({
      buffer: Buffer.from("image"),
      classification: { mime: "image/jpeg", class: "image" },
      mime: "image/jpeg",
      fileName: "file.jpg",
      size: 5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("carries no local path when a blocked path recovers through the URL fallback", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-blocked-" }, async (base) => {
      const blockedPath = path.join(base, "outside-roots", "report.doc");
      await fs.mkdir(path.dirname(blockedPath), { recursive: true });
      await fs.writeFile(blockedPath, "blocked");
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response("remote-bytes", {
          headers: { "content-type": "application/msword" },
        }),
      );
      globalThis.fetch = withFetchPreconnect(fetchSpy);

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: blockedPath, url: "http://198.18.0.153/report.doc" }],
        {
          localPathRoots: [path.join(base, "allowed-only")],
          includeDefaultLocalPathRoots: false,
          ssrfPolicy: { allowRfc2544BenchmarkRange: true },
        },
      );

      const result = await read(cache);

      // Bytes recovered remotely; the blocked path must never surface as a
      // self-serve target in model context.
      expect(result.buffer.toString()).toBe("remote-bytes");
      expect(result.localPath).toBeUndefined();
    });
  });

  it("resolves each relative attachment against its own workspace", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-workspaces-" }, async (base) => {
      const workspaces = ["first", "second"].map((name) => path.join(base, name));
      await Promise.all(
        workspaces.map(async (workspaceDir, index) => {
          await fs.mkdir(workspaceDir, { recursive: true });
          await fs.writeFile(path.join(workspaceDir, "attachment.txt"), `slot-${index}`);
        }),
      );
      const cache = new MediaAttachmentCache(
        workspaces.map((workspaceDir, index) => ({
          index,
          path: "attachment.txt",
          workspaceDir,
        })),
        { localPathRoots: workspaces },
      );

      await expect(
        Promise.all(
          workspaces.map((_workspaceDir, attachmentIndex) =>
            cache.getBuffer({ attachmentIndex, maxBytes: 1024, timeoutMs: 1000 }),
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ buffer: Buffer.from("slot-0") }),
        expect.objectContaining({ buffer: Buffer.from("slot-1") }),
      ]);
    });
  });

  it("resolves managed inbound media URI attachments", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-managed-inbound-" }, async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const saved = await saveMediaBuffer(Buffer.from("managed-media"), "text/plain", "inbound");

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: `media://inbound/${encodeURIComponent(saved.id)}` }],
        {
          localPathRoots: [path.join(stateDir, "media")],
        },
      );

      const result = await read(cache);

      expect(result.buffer.toString()).toBe("managed-media");
      expect(result.fileName).toBe(saved.id);
    });
  });

  it("blocks nested managed inbound media URI attachments", async () => {
    const cache = new MediaAttachmentCache([
      { index: 0, path: "media://inbound/nested%2Ffile.pdf" },
    ]);

    await expect(read(cache)).rejects.toThrow(/outside allowed roots/i);
  });

  it("prefers an existing cwd-relative attachment over a state-relative collision", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-relative-collision-" }, async (base) => {
      const cache = await collision(base, true);
      const result = await read(cache);

      expect(result.buffer.toString()).toBe("cwd-media");
    });
  });

  it("falls back to state media when a cwd collision is outside allowed roots", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-blocked-cwd-collision-" }, async (base) => {
      const cache = await collision(base, false);
      const result = await read(cache);

      expect(result.buffer.toString()).toBe("state-media");
    });
  });

  it("blocks local attachments outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const cache = new MediaAttachmentCache([{ index: 0, path: "/etc/passwd" }], {
      localPathRoots: ["/Users/*/Library/Messages/Attachments"],
    });

    await expect(read(cache)).rejects.toThrow(/outside allowed roots/i);
  });

  it("blocks directory attachments even inside configured roots", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-dir-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "nested");
      await fs.mkdir(attachmentPath, { recursive: true });

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(read(cache)).rejects.toThrow(/not a regular file/i);
    });
  });

  it("blocks symlink escapes that resolve outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTestDir({ prefix: "openclaw-media-cache-symlink-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const outsidePath = "/etc/passwd";
      const symlinkPath = path.join(allowedRoot, "note.txt");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.symlink(outsidePath, symlinkPath);

      const cache = new MediaAttachmentCache([{ index: 0, path: symlinkPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(read(cache)).rejects.toThrow(/outside allowed roots/i);
    });
  });

  it("opens local attachments with nofollow on posix", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withLocalAttachmentCache(
      "openclaw-media-cache-flags-",
      async ({ cache, canonicalAttachmentPath }) => {
        const openSpy = vi.spyOn(fs, "open");

        await read(cache);

        expect(openSpy).toHaveBeenCalled();
        const [openedPath, openedFlags] = mockCall(openSpy);
        expect(await fs.realpath(String(openedPath)).catch(() => String(openedPath))).toBe(
          canonicalAttachmentPath,
        );
        // fs-safe 0.5.2 may add O_NONBLOCK so a raced FIFO cannot pin a worker.
        expect(Number(openedFlags) & ~fsConstants.O_NONBLOCK).toBe(
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      },
    );
  });

  it("rejects local attachments when canonicalization fails", async () => {
    await withLocalAttachmentCache(
      "openclaw-media-cache-realpath-failure-",
      async ({ cache, attachmentPath }) => {
        vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
          if (params.filePath === attachmentPath) {
            throw new Error("EACCES");
          }
          throw new Error(`Unexpected attachment path: ${params.filePath}`);
        });

        await expect(read(cache)).rejects.toThrow(/could not be canonicalized/i);
      },
    );
  });
});
