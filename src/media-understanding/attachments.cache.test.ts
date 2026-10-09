// Attachment cache tests cover bounded reads, MIME detection, and temporary-file ownership.
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { MediaAttachmentCache } from "./attachments.js";
import { resolveMediaAttachmentLocalRoots } from "./runner.attachments.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return {
    ...actual,
    readRemoteMediaBuffer: readRemoteMediaBufferMock,
  };
});

vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: vi.fn(actual.resolvePreferredOpenClawTmpDir),
  };
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const AMBIGUOUS_WEBM = Buffer.from("1a45dfa3874282847765626d", "hex");

describe("media understanding attachment cache", () => {
  it.each(["canonical", "directory alias"] as const)(
    "keeps session-scoped roots authoritative for %s attachment paths",
    async (spelling) => {
      await withTestDir({ prefix: "openclaw-media-cache-session-scoped-" }, async (base) => {
        const stateDir = path.join(base, "state");
        const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "session-a");
        const siblingDir = path.join(stateDir, "sandboxes", "session-b");
        const sharedWorkspaceDir = path.join(stateDir, "workspace");
        for (const dir of [sessionWorkspaceDir, siblingDir, sharedWorkspaceDir]) {
          await fs.mkdir(dir, { recursive: true });
        }
        const ownFile = path.join(sessionWorkspaceDir, "own.txt");
        const siblingFile = path.join(siblingDir, "sibling.txt");
        const hostWorkspaceFile = path.join(sharedWorkspaceDir, "host-secret.txt");
        await fs.writeFile(ownFile, "OWN-SANDBOX-CONTENT");
        await fs.writeFile(siblingFile, "SIBLING-SANDBOX-CONTENT");
        await fs.writeFile(hostWorkspaceFile, "SHARED-HOST-WORKSPACE-CONTENT");
        let sourceStateDir = stateDir;
        if (spelling === "directory alias") {
          sourceStateDir = path.join(base, "state-alias");
          await fs.symlink(
            stateDir,
            sourceStateDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        const sourcePath = (file: string) =>
          path.join(sourceStateDir, path.relative(stateDir, file));

        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        try {
          const roots = resolveMediaAttachmentLocalRoots({
            cfg: {} as never,
            ctx: {} as never,
            workspaceDir: sessionWorkspaceDir,
          });
          // Production construction (apply.ts / file-context.ts): the scoped root set is
          // authoritative — merging sessionless defaults back in would restore the shared
          // workspace/sandbox parents for sandboxed sessions.
          const cache = new MediaAttachmentCache(
            [
              { index: 0, path: sourcePath(ownFile) },
              { index: 1, path: sourcePath(siblingFile) },
              { index: 2, path: sourcePath(hostWorkspaceFile) },
            ],
            { localPathRoots: roots, includeDefaultLocalPathRoots: false },
          );

          const own = await cache.getBuffer({
            attachmentIndex: 0,
            maxBytes: 1024,
            timeoutMs: 1000,
          });
          expect(own.buffer.toString()).toBe("OWN-SANDBOX-CONTENT");
          await expect(
            cache.getBuffer({ attachmentIndex: 1, maxBytes: 1024, timeoutMs: 1000 }),
          ).rejects.toThrow(/outside allowed roots/i);
          await expect(
            cache.getBuffer({ attachmentIndex: 2, maxBytes: 1024, timeoutMs: 1000 }),
          ).rejects.toThrow(/outside allowed roots/i);
        } finally {
          vi.unstubAllEnvs();
        }
      });
    },
  );

  it("rejects an alias retargeted outside the granted root before opening", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-alias-retarget-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const outsideRoot = path.join(base, "outside");
      const alias = path.join(base, "alias");
      for (const root of [allowedRoot, outsideRoot]) {
        await fs.mkdir(root);
        await fs.writeFile(path.join(root, "note.txt"), path.basename(root));
      }
      const aliasType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(allowedRoot, alias, aliasType);
      const openLocalFileSafely = fsSafe.openLocalFileSafely;
      const openSpy = vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
        await fs.unlink(alias);
        await fs.symlink(outsideRoot, alias, aliasType);
        return await openLocalFileSafely(params);
      });
      const cache = new MediaAttachmentCache([{ index: 0, path: path.join(alias, "note.txt") }], {
        localPathRoots: [allowedRoot],
        includeDefaultLocalPathRoots: false,
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toMatchObject({ reason: "blocked" });
      expect(openSpy).toHaveBeenCalledOnce();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(resolvePreferredOpenClawTmpDir).mockReset();
    readRemoteMediaBufferMock.mockReset();
  });

  it("passes cancellation through the guarded download without retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("reply stopped");
    const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
    readRemoteMediaBufferMock.mockImplementation(actual.readRemoteMediaBuffer);
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(
        new ReadableStream({
          pull(stream) {
            controller.abort(reason);
            stream.error(new DOMException("download aborted", "AbortError"));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/notes.txt" }], {
      signal: controller.signal,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toBe(reason);

    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    await cache.cleanup();
  });

  it.each(["getBuffer", "getPath"] as const)(
    "refuses canceled %s even when the attachment was already cached",
    async (method) => {
      const controller = new AbortController();
      const reason = new Error("reply stopped");
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }], {
        signal: controller.signal,
      });
      const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 };
      await cache.getBuffer(request);
      controller.abort(reason);
      try {
        await expect(cache[method](request)).rejects.toBe(reason);
        expect(readRemoteMediaBufferMock).toHaveBeenCalledOnce();
      } finally {
        await cache.cleanup();
      }
    },
  );

  it("closes a local handle canceled during validation without trying the remote fallback", async () => {
    const base = tempDirs.make("openclaw-media-cache-abort-local-");
    const localPath = path.join(base, "note.txt");
    await fs.writeFile(localPath, "local text");
    const controller = new AbortController();
    const reason = new Error("reply stopped");
    const open = fsSafe.openLocalFileSafely;
    const closed = vi.fn();
    vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementationOnce(async (params) => {
      const opened = await open(params);
      const close = opened.handle.close.bind(opened.handle);
      vi.spyOn(opened.handle, "close").mockImplementation(async () => {
        closed();
        await close();
      });
      controller.abort(reason);
      return opened;
    });
    const cache = new MediaAttachmentCache(
      [{ index: 0, path: localPath, url: "https://example.com/note.txt" }],
      { localPathRoots: [base], includeDefaultLocalPathRoots: false, signal: controller.signal },
    );

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toBe(reason);

    expect(closed).toHaveBeenCalledOnce();
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
  });

  it("retains an aborted staging write until the cache owner cleans it up", async () => {
    const base = tempDirs.make("openclaw-media-cache-abort-stage-");
    vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
    readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
    const controller = new AbortController();
    const reason = new Error("reply stopped");
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      controller.abort(reason);
    });
    const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }], {
      signal: controller.signal,
    });
    try {
      await expect(
        cache.getPath({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toBe(reason);
      expect(await fs.readdir(base)).toHaveLength(1);
    } finally {
      await cache.cleanup();
    }
    expect(await fs.readdir(base)).toEqual([]);
  });

  it.each<{
    source: "local" | "remote";
    fileName: string;
    bytes: () => Buffer | Promise<Buffer>;
    declaredMime: string;
    contentType?: string;
    expected: { mime: string; class: string };
  }>([
    {
      source: "local",
      fileName: "photo.jpg",
      bytes: () => PNG_1X1,
      declaredMime: "application/pdf",
      expected: { mime: "image/png", class: "image" },
    },
    {
      source: "local",
      fileName: "notes",
      bytes: () => Buffer.from("验证".repeat(700), "utf8"),
      declaredMime: "application/octet-stream",
      expected: { mime: "text/plain", class: "text" },
    },
    {
      source: "remote",
      fileName: "photo.jpg",
      bytes: () => PNG_1X1,
      declaredMime: "application/pdf",
      contentType: "image/jpeg",
      expected: { mime: "image/png", class: "image" },
    },
    {
      source: "remote",
      fileName: "voice.webm",
      bytes: () => AMBIGUOUS_WEBM,
      declaredMime: "application/pdf",
      contentType: "audio/webm",
      expected: { mime: "audio/webm", class: "audio" },
    },
    {
      source: "remote",
      fileName: "download",
      bytes: () => new JSZip().file("hello.txt", "hi").generateAsync({ type: "nodebuffer" }),
      declaredMime: "application/pdf",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expected: {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        class: "document",
      },
    },
  ])("classifies $source $fileName as $expected.mime despite declared MIME", async (testCase) => {
    await withTestDir({ prefix: "openclaw-media-cache-mime-" }, async (base) => {
      const buffer = await testCase.bytes();
      const attachmentPath = path.join(base, testCase.fileName);
      if (testCase.source === "local") {
        await fs.writeFile(attachmentPath, buffer);
      } else {
        readRemoteMediaBufferMock.mockResolvedValue({
          buffer,
          contentType: testCase.contentType,
          fileName: testCase.fileName,
        });
      }
      const cache = new MediaAttachmentCache(
        [
          {
            index: 0,
            mime: testCase.declaredMime,
            ...(testCase.source === "local"
              ? { path: attachmentPath }
              : { url: `https://example.com/${testCase.fileName}` }),
          },
        ],
        { localPathRoots: [base] },
      );

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: buffer.byteLength,
        timeoutMs: 1000,
      });

      expect(result.mime).toBe(testCase.expected.mime);
      expect(result.classification).toEqual(testCase.expected);
      expect(result.buffer).toEqual(buffer);
    });
  });

  it.each(["unchanged", "growing", "read-failure"] as const)(
    "closes one bounded local read when the file is %s",
    async (behavior) => {
      await withTestDir({ prefix: "openclaw-media-cache-growth-" }, async (base) => {
        const attachmentPath = path.join(base, "growing.png");
        await fs.writeFile(attachmentPath, PNG_1X1);
        const maxBytes = PNG_1X1.length;
        const open = fs.open.bind(fs);
        let consumed = 0;
        let opens = 0;
        let closes = 0;
        let grew = false;
        const readError = new Error("synthetic read failure");
        const growBeforeRead = async () => {
          if (behavior === "read-failure") {
            throw readError;
          }
          if (behavior === "growing" && !grew) {
            grew = true;
            await fs.appendFile(attachmentPath, Buffer.alloc(4096));
          }
        };
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          opens += 1;
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            closes += 1;
            await close();
          });
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            await growBeforeRead();
            const result = await read(...readArgs);
            consumed += result.bytesRead;
            return result;
          });
          const readFile = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => {
            await growBeforeRead();
            const result = await readFile(...readArgs);
            consumed += result.length;
            return result;
          });
          return handle;
        });
        const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
          localPathRoots: [base],
          includeDefaultLocalPathRoots: false,
        });

        const result = cache.getBuffer({ attachmentIndex: 0, maxBytes, timeoutMs: 1000 });
        if (behavior === "unchanged") {
          await expect(result).resolves.toMatchObject({ buffer: PNG_1X1 });
        } else if (behavior === "growing") {
          await expect(result).rejects.toMatchObject({ reason: "maxBytes" });
        } else {
          await expect(result).rejects.toBe(readError);
        }
        expect(opens).toBe(1);
        expect(closes).toBe(opens);
        expect(consumed).toBe(behavior === "read-failure" ? 0 : maxBytes + Number(grew));
      });
    },
  );

  it.each(["local", "staged"] as const)(
    "enforces a zero-byte path limit for %s files",
    async (source) => {
      expectTypeOf<Parameters<MediaAttachmentCache["getPath"]>[0]>().toEqualTypeOf<{
        attachmentIndex: number;
        maxBytes: number;
        timeoutMs: number;
      }>();
      await withTestDir({ prefix: "openclaw-media-cache-path-limit-" }, async (base) => {
        const attachmentPath = path.join(base, "photo.png");
        await fs.writeFile(attachmentPath, PNG_1X1);
        vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
        readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
        const attachment =
          source === "local"
            ? { index: 0, path: attachmentPath }
            : { index: 0, url: "https://example.com/photo.png" };
        const cache = new MediaAttachmentCache([attachment], { localPathRoots: [base] });
        const request = { attachmentIndex: 0, maxBytes: PNG_1X1.length, timeoutMs: 1000 };
        try {
          await expect(cache.getPath(request)).resolves.toEqual(expect.any(String));
          await expect(cache.getPath({ ...request, maxBytes: 0 })).rejects.toMatchObject({
            reason: "maxBytes",
          });
        } finally {
          await cache.cleanup();
        }
      });
    },
  );

  it.each([
    { fileName: "photo.png", extension: ".png", removeBeforeCleanup: false },
    { fileName: "photo.a:b", extension: ".b", removeBeforeCleanup: true },
  ])(
    "restages $fileName with a safe suffix after cache cleanup",
    async ({ fileName, extension, removeBeforeCleanup }) => {
      await withTestDir({ prefix: "openclaw-media-cache-restage-" }, async (base) => {
        vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
        readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName });
        const cache = new MediaAttachmentCache([
          { index: 0, url: "https://example.com/photo.png" },
        ]);
        const request = { attachmentIndex: 0, maxBytes: PNG_1X1.length, timeoutMs: 1000 };
        try {
          const first = await cache.getPath(request);
          expect(path.extname(first)).toBe(extension);
          if (removeBeforeCleanup) {
            await fs.unlink(first);
          }
          await cache.cleanup();
          await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readdir(base)).toEqual([]);
          const second = await cache.getPath(request);
          expect(second).not.toBe(first);
          expect(path.extname(second)).toBe(extension);
          await expect(fs.readFile(second)).resolves.toEqual(PNG_1X1);
          expect(await cache.getPath(request)).toBe(second);
          expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(1);
        } finally {
          await cache.cleanup();
        }
        expect(await fs.readdir(base)).toEqual([]);
      });
    },
  );

  it("keeps buffer-only and local-path access lazy without releasing borrowed bytes", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-lazy-" }, async (base) => {
      vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
      const localPath = path.join(base, "photo.png");
      await fs.writeFile(localPath, PNG_1X1);
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      const cache = new MediaAttachmentCache(
        [
          { index: 0, url: "https://example.com/photo.png" },
          { index: 1, path: localPath },
        ],
        { localPathRoots: [base], includeDefaultLocalPathRoots: false },
      );
      const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 };
      const borrowed = await cache.getBuffer(request);
      await cache.getBuffer({ ...request, attachmentIndex: 1 });
      expect(await cache.getPath({ ...request, attachmentIndex: 1 })).toBe(localPath);
      await cache.cleanup();
      expect(await fs.readdir(base)).toEqual(["photo.png"]);
      expect(resolvePreferredOpenClawTmpDir).not.toHaveBeenCalled();
      expect(await cache.getBuffer(request)).toBe(borrowed);
      cache.releaseBuffer(0);
      expect(await cache.getBuffer(request)).not.toBe(borrowed);
      expect(borrowed.buffer).toBe(PNG_1X1);
      expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(2);
    });
  });

  it.each([false, true])(
    "does not return a local path after its validation open fails (URL fallback: %s)",
    async (hasFallback) => {
      await withTestDir({ prefix: "openclaw-media-cache-open-failure-" }, async (base) => {
        vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
        const attachmentPath = path.join(base, "local.png");
        await fs.writeFile(attachmentPath, PNG_1X1);
        readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "remote.png" });
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (args[0] === attachmentPath) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return await open(...args);
        });
        const cache = new MediaAttachmentCache(
          [
            {
              index: 0,
              path: attachmentPath,
              url: hasFallback ? "https://example.com/photo.png" : undefined,
            },
          ],
          { localPathRoots: [base], includeDefaultLocalPathRoots: false },
        );
        try {
          const result = cache.getPath({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 });
          if (hasFallback) {
            const staged = await result;
            expect(staged).not.toBe(attachmentPath);
            await expect(fs.readFile(staged)).resolves.toEqual(PNG_1X1);
          } else {
            await expect(result).rejects.toMatchObject({ reason: "blocked" });
          }
          expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(Number(hasFallback));
        } finally {
          await cache.cleanup();
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "stages in a selector-approved fallback root and preserves unrelated files",
    async () => {
      await withTestDir({ prefix: "openclaw-media-cache-fallback-root-" }, async (base) => {
        const preferredDir = path.join(base, "preferred-is-a-file");
        const fallbackParent = path.join(base, "shared-tmp");
        await fs.writeFile(preferredDir, "unavailable preferred directory");
        await fs.mkdir(fallbackParent);
        await fs.chmod(fallbackParent, 0o770);
        const actual = await vi.importActual<typeof import("../infra/tmp-openclaw-dir.js")>(
          "../infra/tmp-openclaw-dir.js",
        );
        vi.mocked(resolvePreferredOpenClawTmpDir).mockImplementation(() =>
          actual.resolvePreferredOpenClawTmpDir({ preferredDir, tmpdir: () => fallbackParent }),
        );
        const selectedRoot = resolvePreferredOpenClawTmpDir();
        await fs.writeFile(path.join(selectedRoot, "unrelated.txt"), "keep");
        readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
        const cache = new MediaAttachmentCache(
          [{ index: 0, url: "https://example.com/photo.png" }],
          { includeDefaultLocalPathRoots: false },
        );
        try {
          const staged = await cache.getPath({
            attachmentIndex: 0,
            maxBytes: 1024,
            timeoutMs: 1_000,
          });
          expect(path.dirname(staged)).toBe(selectedRoot);
          await expect(fs.readFile(staged)).resolves.toEqual(PNG_1X1);
        } finally {
          await cache.cleanup();
        }
        expect(await fs.readdir(selectedRoot)).toEqual(["unrelated.txt"]);
        expect((await fs.stat(selectedRoot)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(fallbackParent)).mode & 0o777).toBe(0o770);
      });
    },
  );

  it("keeps a successful concurrent path when another staging attempt fails", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-concurrent-" }, async (base) => {
      vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }]);
      const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 };
      const started = createDeferred();
      const finish = createDeferred();
      const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        await writeFile(file, PNG_1X1.subarray(0, 4));
        started.resolve();
        await finish.promise;
        throw writeError;
      });
      const failed = expect(cache.getPath(request)).rejects.toBe(writeError);
      try {
        await started.promise;
        const successful = await cache.getPath(request);
        finish.resolve();
        await failed;
        expect(await fs.readdir(base)).toEqual([path.basename(successful)]);
        await expect(fs.readFile(successful)).resolves.toEqual(PNG_1X1);
        expect(await cache.getPath(request)).toBe(successful);
      } finally {
        finish.resolve();
        await failed;
        await cache.cleanup();
      }
      expect(await fs.readdir(base)).toEqual([]);
    });
  });

  it("retries failed cleanup without losing earlier staging when a later attempt succeeds", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-cleanup-retry-" }, async (base) => {
      const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      const cleanupError = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const writeFile = fs.writeFile.bind(fs);
      vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        await writeFile(file, PNG_1X1.subarray(0, 4));
        throw writeError;
      });
      const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(cleanupError);
      const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }]);
      const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 };

      await expect(cache.getPath(request)).rejects.toBe(writeError);
      expect(await fs.readdir(base)).toHaveLength(1);

      const staged = await cache.getPath(request);
      await expect(fs.readFile(staged)).resolves.toEqual(PNG_1X1);
      expect(await cache.getPath(request)).toBe(staged);
      expect(writeFileSpy).toHaveBeenCalledTimes(2);
      expect(await fs.readdir(base)).toHaveLength(2);

      unlink.mockRejectedValueOnce(cleanupError);
      await cache.cleanup();
      expect(await fs.readdir(base)).toHaveLength(1);

      await cache.cleanup();
      expect(await fs.readdir(base)).toEqual([]);
    });
  });

  it("retains files staged after cleanup takes its snapshot", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-cleanup-snapshot-" }, async (base) => {
      vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
      readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
      const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/photo.png" }]);
      const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1_000 };
      const first = await cache.getPath(request);
      const started = createDeferred();
      const finish = createDeferred();
      const unlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementationOnce(async (file) => {
        started.resolve();
        await finish.promise;
        await unlink(file);
      });
      const cleaning = cache.cleanup();
      try {
        await started.promise;
        const second = await cache.getPath(request);
        expect(second).not.toBe(first);
        finish.resolve();
        await cleaning;
        await expect(fs.readFile(second)).resolves.toEqual(PNG_1X1);
        expect(await cache.getPath(request)).toBe(second);
      } finally {
        finish.resolve();
        await cleaning;
        await cache.cleanup();
      }
      expect(await fs.readdir(base)).toEqual([]);
    });
  });
});
