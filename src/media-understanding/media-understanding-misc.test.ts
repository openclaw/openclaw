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

it("matches channel chatType explicitly", () => {
  expect(
    resolveMediaUnderstandingScope({
      scope: { rules: [{ action: "deny", match: { chatType: "channel" } }] },
      chatType: "channel",
    }),
  ).toBe("deny");
});

const originalFetch = globalThis.fetch;
const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const withDir = (run: (base: string) => Promise<void>) =>
  withTestDir({ prefix: "openclaw-media-cache-" }, run);
const read = (cache: MediaAttachmentCache, attachmentIndex = 0) =>
  cache.getBuffer({ attachmentIndex, maxBytes: 1024, timeoutMs: 1000 });

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function download(text: string, mime: string) {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(text, { headers: { "content-type": mime } }));
  globalThis.fetch = withFetchPreconnect(fetch);
  return fetch;
}
async function withLocal(
  run: (cache: MediaAttachmentCache, file: string) => Promise<void>,
  kind: "file" | "directory" | "symlink" = "file",
) {
  await withDir(async (base) => {
    const root = path.join(base, "allowed");
    const file = path.join(
      root,
      kind === "file" ? "voice-note.m4a" : kind === "directory" ? "nested" : "note.txt",
    );
    await fs.mkdir(root);
    if (kind === "directory") {
      await fs.mkdir(file);
    } else if (kind === "symlink") {
      await fs.symlink("/etc/passwd", file);
    } else {
      await fs.writeFile(file, "ok");
    }
    await run(
      new MediaAttachmentCache([{ index: 0, path: file }], { localPathRoots: [root] }),
      file,
    );
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
    const attachment = { index: 0, url: "http://198.18.0.153/file.jpg" };
    await expect(read(new MediaAttachmentCache([attachment]))).rejects.toThrow(
      /private|internal|blocked/i,
    );
    const fetchSpy = download("image", "image/jpeg");
    const cache = new MediaAttachmentCache([attachment], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(await read(cache)).toStrictEqual({
      buffer: Buffer.from("image"),
      classification: { mime: "image/jpeg", class: "image" },
      mime: "image/jpeg",
      fileName: "file.jpg",
      size: 5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("carries no local path when a blocked path recovers through the URL fallback", async () => {
    await withDir(async (base) => {
      const blockedPath = path.join(base, "outside-roots", "report.doc");
      await write(blockedPath, "blocked");
      download("remote-bytes", "application/msword");
      const cache = new MediaAttachmentCache(
        [{ index: 0, path: blockedPath, url: "http://198.18.0.153/report.doc" }],
        {
          localPathRoots: [path.join(base, "allowed-only")],
          includeDefaultLocalPathRoots: false,
          ssrfPolicy: { allowRfc2544BenchmarkRange: true },
        },
      );
      const result = await read(cache);
      expect(result.buffer.toString()).toBe("remote-bytes");
      expect(result.localPath).toBeUndefined();
    });
  });

  it("resolves each relative attachment against its own workspace", async () => {
    await withDir(async (base) => {
      const workspaces = ["first", "second"].map((name) => path.join(base, name));
      await Promise.all(
        workspaces.map((dir, index) => write(path.join(dir, "attachment.txt"), `slot-${index}`)),
      );
      const cache = new MediaAttachmentCache(
        workspaces.map((workspaceDir, index) => ({ index, path: "attachment.txt", workspaceDir })),
        { localPathRoots: workspaces },
      );
      await expect(Promise.all(workspaces.map((_, index) => read(cache, index)))).resolves.toEqual([
        expect.objectContaining({ buffer: Buffer.from("slot-0") }),
        expect.objectContaining({ buffer: Buffer.from("slot-1") }),
      ]);
    });
  });

  it("resolves managed inbound media URI attachments", async () => {
    await withDir(async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const saved = await saveMediaBuffer(Buffer.from("managed-media"), "text/plain", "inbound");
      const cache = new MediaAttachmentCache(
        [{ index: 0, path: `media://inbound/${encodeURIComponent(saved.id)}` }],
        { localPathRoots: [path.join(stateDir, "media")] },
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

  it.each([true, false])(
    "resolves cwd/state collisions with cwd allowed: %s",
    async (allowedCwd) => {
      await withDir(async (base) => {
        const stateDir = path.join(base, "state");
        const cwd = path.join(base, "cwd");
        const relativePath = "media/inbound/photo.jpg";
        await write(path.join(cwd, relativePath), "cwd-media");
        await write(path.join(stateDir, relativePath), "state-media");
        setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
        vi.spyOn(process, "cwd").mockReturnValue(cwd);
        const roots = (allowedCwd ? [cwd, stateDir] : [stateDir]).map((root) =>
          path.join(root, "media"),
        );
        const cache = new MediaAttachmentCache([{ index: 0, path: relativePath }], {
          localPathRoots: roots,
        });
        expect((await read(cache)).buffer.toString()).toBe(
          allowedCwd ? "cwd-media" : "state-media",
        );
      });
    },
  );

  it("blocks local attachments outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const cache = new MediaAttachmentCache([{ index: 0, path: "/etc/passwd" }], {
      localPathRoots: ["/Users/*/Library/Messages/Attachments"],
    });
    await expect(read(cache)).rejects.toThrow(/outside allowed roots/i);
  });

  it.each([
    ["directory", /not a regular file/i],
    ["symlink", /outside allowed roots/i],
  ] as const)("blocks %s attachments inside configured roots", async (kind, error) => {
    if (kind === "symlink" && process.platform === "win32") {
      return;
    }
    await withLocal(async (cache) => {
      await expect(read(cache)).rejects.toThrow(error);
    }, kind);
  });

  it("opens local attachments with nofollow on posix", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withLocal(async (cache, file) => {
      const openSpy = vi.spyOn(fs, "open");
      await read(cache);
      expect(openSpy).toHaveBeenCalled();
      const [openedPath, openedFlags] = mockCall(openSpy);
      expect(await fs.realpath(String(openedPath)).catch(() => String(openedPath))).toBe(
        await fs.realpath(file),
      );
      // fs-safe may add O_NONBLOCK so a raced FIFO cannot pin a worker.
      expect(Number(openedFlags) & ~fsConstants.O_NONBLOCK).toBe(
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    });
  });

  it("rejects local attachments when canonicalization fails", async () => {
    await withLocal(async (cache, file) => {
      vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
        if (params.filePath === file) {
          throw new Error("EACCES");
        }
        throw new Error(`Unexpected attachment path: ${params.filePath}`);
      });
      await expect(read(cache)).rejects.toThrow(/could not be canonicalized/i);
    });
  });
});
