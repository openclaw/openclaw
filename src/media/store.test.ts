import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import JSZip from "jszip";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isPathWithinBase } from "../../test/helpers/paths.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { expectSavedOriginalFilenameCase } from "./store-filename.test-support.js";

const binaryMime = "application/octet-stream";
const streamDir = "stream-inbound";

type FileStore = ReturnType<(typeof import("@openclaw/fs-safe/store"))["fileStore"]>;

function mockFileStore(wrap: (store: FileStore) => Partial<FileStore>) {
  vi.doMock("@openclaw/fs-safe/store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@openclaw/fs-safe/store")>();
    return {
      ...actual,
      fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
        const store = actual.fileStore(options);
        return { ...store, ...wrap(store) };
      },
    };
  });
}

async function fileFixture(filePath: string, content: string | Buffer, ageMs = 0, size?: number) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  if (size !== undefined) {
    await fs.truncate(filePath, size);
  }
  if (ageMs) {
    const time = (Date.now() - ageMs) / 1000;
    await fs.utimes(filePath, time, time);
  }
  return filePath;
}

describe("media store", () => {
  let store: typeof import("./store.js");
  let home = "";
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    home = tempHome.home;
    store = await import("./store.js");
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } finally {
      vi.resetModules();
    }
  });

  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
  });

  async function expectPathMissing(targetPath: string) {
    const result = fs.stat(targetPath);
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({ code: "ENOENT" });
  }

  it.each([
    { maxBytes: undefined, size: 5 * 1024 * 1024 + 1, message: "Media exceeds 5MB limit" },
    { maxBytes: 256 * 1024, size: 256 * 1024 + 1, message: "Media exceeds 256KB limit" },
  ])("enforces buffer size limit: $message", async ({ maxBytes, size, message }) => {
    await expect(
      store.saveMediaBuffer(Buffer.alloc(size), binaryMime, "fractional-buffer", maxBytes),
    ).rejects.toThrow(message);
  });

  async function expectSourceError(
    source: string,
    expected: { code: string; name?: string; message?: string; cause?: unknown },
    maxBytes?: number,
  ) {
    const result = store.saveMediaSource(source, undefined, "outbound", maxBytes);
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject(expected);
    return result.catch((error: unknown) => error);
  }

  it("rejects directory sources with a typed error", async () => {
    await expectSourceError(home, { code: "not-file" });
  });

  it("reports the fractional source byte limit", async () => {
    const source = await fileFixture(
      path.join(home, "fractional-source.bin"),
      Buffer.alloc(1.5 * 1024 * 1024 + 1),
    );
    await expectSourceError(
      source,
      {
        name: "SaveMediaSourceError",
        code: "too-large",
        message: "Media exceeds 1.50MB limit",
        cause: expect.any(Error),
      },
      1.5 * 1024 * 1024,
    );
  });

  it.runIf(process.platform !== "win32")("rejects symlink sources", async () => {
    const target = await fileFixture(path.join(home, "sensitive.txt"), "sensitive");
    const source = path.join(home, "symlink-source.txt");
    await fs.symlink(target, source);
    expect(await expectSourceError(source, { code: "invalid-path" })).toHaveProperty(
      "message",
      expect.stringContaining("symlink"),
    );
  });

  it("saves streams with detected extension without buffering first", async () => {
    const chunk = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const stream = (async function* () {
      yield chunk;
      chunk.fill(0);
    })();
    const saved = await store.saveMediaStream(stream, undefined, streamDir, 1024, "photo.bin");

    expect(saved).toMatchObject({
      id: expect.stringMatching(/^photo---[a-f0-9-]{36}\.jpg$/),
      size: 4,
      contentType: "image/jpeg",
    });
    await expect(fs.readFile(saved.path)).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  });

  it("preserves the original generic extension of stored streams", async () => {
    const buffer = Buffer.from("custom binary");
    const original = "report.CuStOm";
    const saved = await store.saveMediaStream(
      Readable.from([buffer]),
      binaryMime,
      streamDir,
      1024,
      original,
    );
    expect(store.extractOriginalFilename(saved.path)).toBe(original);
    await expect(fs.readFile(saved.path)).resolves.toEqual(buffer);
  });

  it.each(["save", "resolve", "read"] as const)(
    "rejects traversal subdirs before %s",
    async (operation) => {
      const mediaDir = await store.ensureMediaDir();
      const outside = path.join(home, `outside-media-${operation}`);
      if (operation !== "save") {
        await fs.mkdir(outside, { recursive: true });
        await fs.writeFile(path.join(outside, "passwd"), "not media");
      }
      const subdir = path.relative(mediaDir, outside);
      const result =
        operation === "save"
          ? store.saveMediaBuffer(Buffer.from("escape"), "text/plain", subdir)
          : operation === "resolve"
            ? store.resolveMediaBufferPath("passwd", subdir)
            : store.readMediaBuffer("passwd", subdir);
      await expect(result).rejects.toThrow("unsafe media subdir");
      if (operation === "save") {
        await expectPathMissing(outside);
      }
    },
  );

  it.each([
    { contents: "source bytes", maxBytes: undefined },
    { contents: "too large", maxBytes: 3 },
  ])("reads media IDs within limit $maxBytes", async ({ contents, maxBytes }) => {
    const saved = await store.saveMediaBuffer(Buffer.from(contents), "text/plain");
    const result = store.readMediaBuffer(saved.id, "inbound", maxBytes);
    if (maxBytes !== undefined) {
      await expect(result).rejects.toMatchObject({
        name: "FsSafeError",
        code: "too-large",
        message: `readMediaBuffer: media ID ${JSON.stringify(saved.id)} is 9 bytes; maximum is 3 bytes`,
      });
    } else {
      const read = await result;
      await expect(fs.realpath(read.path)).resolves.toBe(await fs.realpath(saved.path));
      expect(read).toMatchObject({ size: contents.length, buffer: Buffer.from(contents) });
    }
  });

  it("finishes short nonblocking media reads", async () => {
    const content = Buffer.from("synthetic media bytes");
    const saved = await store.saveMediaBuffer(content, "text/plain");
    let shortened = false;
    __setFsSafeTestHooksForTest({
      afterOpen: (filePath, handle) => {
        if (path.basename(filePath) !== saved.id) {
          return;
        }
        __setFsSafeTestHooksForTest(undefined);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          shortened = true;
          return await read(buffer, offset, Math.min(1, length), position);
        }) as typeof handle.read);
      },
    });

    const result = await store.readMediaBuffer(saved.id);
    expect(shortened).toBe(true);
    expect(result.buffer.toString("utf8")).toBe(content.toString("utf8"));
    expect(result.size).toBe(content.length);
  });

  it("does not let a mixed-case image header disguise a stored ZIP", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const saved = await store.saveMediaBuffer(
      buffer,
      "IMAGE/PNG",
      "inbound",
      5 * 1024 * 1024,
      "fake.png",
    );
    expect(saved.contentType).toBe("application/zip");
    expect(saved.path.endsWith(".zip")).toBe(true);
    expect(path.basename(saved.path)).toMatch(/^fake---[a-f0-9-]{36}\.zip$/);
  });

  it.each([
    {
      mode: "recursive",
      options: { recursive: true, pruneEmptyDirs: true },
      removed: [0, 1, 2, 4],
    },
    { mode: "shallow", options: undefined, removed: [0, 1] },
    { mode: "root only", options: { recursive: false }, removed: [0] },
  ])(
    "cleans expired media at $mode depth and preserves live siblings",
    async ({ mode, options, removed }) => {
      const mediaDir = await store.ensureMediaDir();
      expect(isPathWithinBase(home, mediaDir)).toBe(true);
      expect(path.normalize(mediaDir)).toContain(`${path.sep}.openclaw${path.sep}media`);
      expect((await fs.stat(mediaDir)).isDirectory()).toBe(true);
      const files = await Promise.all(
        ["", "inbound", "cache/session/images", "cache/session/docs", "prune/session/images"].map(
          (subdir) => store.saveMediaBuffer(Buffer.from("media"), "text/plain", subdir),
        ),
      );
      const past = (Date.now() - 10_000) / 1000;
      for (const [index, saved] of files.entries()) {
        if (index !== 3) {
          await fs.utimes(saved.path, past, past);
        }
      }
      await store.cleanOldMedia(1_000, options);
      for (const [index, saved] of files.entries()) {
        if (removed.includes(index)) {
          await expectPathMissing(saved.path);
        } else {
          expect((await fs.stat(saved.path)).isFile()).toBe(true);
        }
      }
      if (mode === "recursive") {
        for (const subdir of ["cache/session/images", "prune/session", "prune"]) {
          await expectPathMissing(path.join(mediaDir, subdir));
        }
        expect((await fs.stat(mediaDir)).isDirectory()).toBe(true);
      } else {
        expect((await fs.stat(path.join(mediaDir, "inbound"))).isDirectory()).toBe(true);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow symlinked top-level directories during recursive cleanup",
    async () => {
      const mediaDir = await store.ensureMediaDir();
      const outsideDir = path.join(home, "outside-media");
      const outsideFile = path.join(outsideDir, "old.txt");
      const symlinkPath = path.join(mediaDir, "linked-dir");
      await fileFixture(outsideFile, "outside", 10_000);
      await fs.symlink(outsideDir, symlinkPath);

      await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

      const outsideStat = await fs.stat(outsideFile);
      const symlinkStat = await fs.lstat(symlinkPath);
      expect(outsideStat.isFile()).toBe(true);
      expect(symlinkStat.isSymbolicLink()).toBe(true);
    },
  );

  it.each([
    {
      name: "falls back to UUID-only when the original basename has only invalid characters",
      originalFilename: "<>:\u0001.txt",
      expectedIdPattern: /^[a-f0-9-]{36}\.txt$/,
      expectUuidOnly: true,
    },
    {
      name: "strips controls and neutralizes bidi/zero-width formatting",
      originalFilename: "report\rC\nL\tT\fF\x1bE\x00N\x7fD\u202efd\u200bp\ufeffsafe.exe",
      expectedIdPattern: /^reportCLTFEND_fd_p_safe---[a-f0-9-]{36}\.txt$/,
    },
  ] as const)("saveMediaBuffer: $name", (testCase) =>
    expectSavedOriginalFilenameCase(store, testCase),
  );
  describe("playback cache", () => {
    const clearMedia = async () => {
      await fs.rm(store.getMediaDir(), { recursive: true, force: true });
    };
    beforeEach(clearMedia);
    afterEach(clearMedia);
    it("evicts oldest playback transcodes when insertion enforcement exceeds its byte budget", async () => {
      const mediaDir = await store.ensureMediaDir();
      const cacheDir = path.join(mediaDir, store.PLAYBACK_TRANSCODE_SUBDIR);
      const sparseSize = (512 * 1024 * 1024) / 2;
      const oldPath = await fileFixture(path.join(cacheDir, "v2-old.mp4"), "", 2_000, sparseSize);
      const newPath = await fileFixture(path.join(cacheDir, "v2-new.mp4"), "", 1_000, sparseSize);

      const inserted = Buffer.from("inserted");
      const insertedPath = await store.writePlaybackTranscodeCache({
        buffer: inserted,
        fileName: "v2-inserted.mp4",
        maxBytes: inserted.byteLength,
        tempPrefix: ".playback-cache-test",
      });

      await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(newPath)).resolves.toMatchObject({ size: sparseSize });
      await expect(fs.readFile(insertedPath)).resolves.toEqual(inserted);
    });

    it("prunes only playback entries using the fixed seven-day retention", async () => {
      const mediaDir = await store.ensureMediaDir();
      const cacheDir = path.join(mediaDir, store.PLAYBACK_TRANSCODE_SUBDIR);
      const expiredAge = 7 * 24 * 60 * 60 * 1000 + 1_000;
      const freshPath = await fileFixture(path.join(cacheDir, "v2-fresh.m4a"), "fresh", 5 * 60_000);
      const oldPath = await fileFixture(path.join(cacheDir, "v2-expired.m4a"), "old", expiredAge);
      const transientPath = await fileFixture(
        path.join(mediaDir, "expired-transient.m4a"),
        "transient",
        expiredAge,
      );

      await store.prunePlaybackTranscodeCache();

      await expect(fs.stat(freshPath)).resolves.toMatchObject({ size: 5 });
      await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(transientPath)).resolves.toMatchObject({ size: 9 });
    });
  });
});

describe("media store filesystem faults", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  function freshStore(scope: string) {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make(scope));
    return importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      `./store.js?scope=${scope}`,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@openclaw/fs-safe/store");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function errnoError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  it.each(
    (["readdir", "rmdir"] as const).flatMap((operation) =>
      ["EACCES", "EIO", "ENOENT"].map((code) => ({ operation, code })),
    ),
  )(
    "distinguishes media cleanup $operation/$code from missing directories",
    async ({ operation, code }) => {
      const store = await freshStore(`cleanup-${operation}-${code}`);
      const mediaDir = await store.ensureMediaDir();
      const scopedDir = path.join(mediaDir, "inbound");
      const liveFile = await fileFixture(path.join(scopedDir, "live.txt"), "live media");
      const injectedError = errnoError(code);
      let injected = false;
      if (operation === "readdir") {
        const readdir = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          if (args[0] === mediaDir) {
            injected = true;
            if (code !== "ENOENT") {
              throw injectedError;
            }
            await fs.rm(mediaDir, { recursive: true, force: true });
          }
          return await readdir(...args);
        });
      } else {
        const rmdir = fs.rmdir;
        vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
          if (args[0] === scopedDir) {
            injected = true;
            if (code !== "ENOENT") {
              throw injectedError;
            }
            await fs.rm(scopedDir, { recursive: true, force: true });
          }
          return await rmdir(...args);
        });
      }
      const result = store.cleanOldMedia(60_000, { recursive: true, pruneEmptyDirs: true });
      if (code === "ENOENT") {
        await expect(result).resolves.toBeUndefined();
        await expect(fs.stat(liveFile)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(result).rejects.toBe(injectedError);
        await expect(fs.readFile(liveFile, "utf8")).resolves.toBe("live media");
      }
      expect(injected).toBe(true);
    },
  );

  it.each(
    (["readdir", "lstat", "remove"] as const).flatMap((operation) =>
      (operation === "readdir" ? ["EACCES", "EIO"] : ["EACCES", "EIO", "ENOENT"]).map((code) => ({
        operation,
        code,
      })),
    ),
  )(
    "handles playback quota $operation/$code at the writer boundary",
    async ({ operation, code }) => {
      const injectedError = errnoError(code);
      const oldName = "v2-quota-old.mp4";
      const insertedName = "v2-quota-inserted.mp4";
      let injected = false;
      if (operation === "remove") {
        mockFileStore((actualStore) => ({
          remove: async (...args) => {
            if (args[0] === `playback-transcode/${oldName}`) {
              injected = true;
              if (code !== "ENOENT") {
                throw injectedError;
              }
              await fs.unlink(actualStore.path(args[0]));
            }
            return await actualStore.remove(...args);
          },
        }));
      }
      const store = await freshStore(`playback-quota-${operation}-${code}`);
      const cacheDir = path.join(await store.ensureMediaDir(), store.PLAYBACK_TRANSCODE_SUBDIR);
      const oldPath = path.join(cacheDir, oldName);
      const oldSize = 512 * 1024 * 1024;
      await fileFixture(oldPath, "", 2_000, oldSize);
      if (operation === "readdir") {
        const readdir = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          if (args[0] === cacheDir) {
            injected = true;
            throw injectedError;
          }
          return await readdir(...args);
        });
      } else if (operation === "lstat") {
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (args[0] === oldPath) {
            injected = true;
            if (code !== "ENOENT") {
              throw injectedError;
            }
            await fs.unlink(oldPath);
          }
          return await lstat(...args);
        });
      }
      const result = store.writePlaybackTranscodeCache({
        buffer: Buffer.from("x"),
        fileName: insertedName,
        maxBytes: 1,
        tempPrefix: ".playback-quota-test",
      });
      if (code === "ENOENT") {
        await expect(result).resolves.toBe(path.join(cacheDir, insertedName));
        await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(result).rejects.toBe(injectedError);
        await expect(fs.stat(oldPath)).resolves.toMatchObject({ size: oldSize });
      }
      expect(injected).toBe(true);
      await expect(fs.readFile(path.join(cacheDir, insertedName), "utf8")).resolves.toBe("x");
    },
  );

  it.each(["ENOENT", "ENOSPC", "not-found", "wrapped-ENOENT", "wrapped-ENOSPC"] as const)(
    "does not replay failed buffer writes (%s)",
    async (code) => {
      const segment = "retry-buffer";
      const nestedError = code.startsWith("wrapped-") ? errnoError(code.slice(8)) : undefined;
      const injectedError =
        code === "not-found" || nestedError
          ? new FsSafeError(
              "not-found",
              "media target not found",
              nestedError ? { cause: nestedError } : undefined,
            )
          : errnoError(code);
      const attempts: string[] = [];
      mockFileStore((actual) => ({
        write: async (...args) => {
          if (args[0].includes(`${segment}/`)) {
            attempts.push(args[0]);
            if (code === "ENOSPC" || attempts.length === 1) {
              if (code === "ENOENT") {
                await fs.rm(path.dirname(actual.path(args[0])), { recursive: true, force: true });
              }
              throw injectedError;
            }
          }
          return actual.write(...args);
        },
      }));
      const scoped = await freshStore(`buffer-write-${code}`);
      const result = scoped.saveMediaBuffer(Buffer.from("voice"), "audio/ogg", segment);
      await expect(result).rejects.toBe(code === "wrapped-ENOSPC" ? nestedError : injectedError);
      expect(attempts).toHaveLength(1);
      if (code.endsWith("ENOSPC")) {
        await expect(result).rejects.toMatchObject({ code: "ENOSPC" });
        expect(path.basename(attempts[0] ?? "")).toMatch(/^[^/\\]+\.ogg$/);
        expect(
          await fs.readdir(path.join(await scoped.ensureMediaDir(), segment)).catch(() => []),
        ).toStrictEqual([]);
      }
    },
  );

  it("rejects missing stream staging without consuming the source", async () => {
    const subdir = "stream-before-open";
    const input = Buffer.from("media stream must not be consumed before staging");
    let consumptionStarted = false;
    const stream = (async function* () {
      consumptionStarted = true;
      yield input;
    })();
    const originalOpen = fs.open.bind(fs);
    let directoryPruned = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (
        !directoryPruned &&
        typeof args[0] === "string" &&
        args[0].includes(`${path.sep}${subdir}${path.sep}`) &&
        args[1] === "wx"
      ) {
        await fs.rmdir(path.dirname(args[0]));
        directoryPruned = true;
      }
      return await originalOpen(...args);
    });

    const store = await freshStore("stream-before-open");
    await expect(store.saveMediaStream(stream, "text/plain", subdir, 1024)).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(directoryPruned).toBe(true);
    expect(consumptionStarted).toBe(false);
  });

  it("rejects publication failure without replaying a consumed stream", async () => {
    const subdir = "stream-final-rename";
    const input = Buffer.from("media stream must not become an empty success");
    const stream = (async function* () {
      yield input;
    })();
    const injectedError = errnoError("ENOENT");
    const originalRename = fs.rename.bind(fs);
    let stagedBytes: Buffer | undefined;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (
        !stagedBytes &&
        typeof target === "string" &&
        target.includes(`${path.sep}${subdir}${path.sep}`) &&
        path.basename(target).startsWith("publication---")
      ) {
        stagedBytes = await fs.readFile(source);
        throw injectedError;
      }
      return await originalRename(source, target);
    });

    const store = await freshStore("stream-final-rename");
    await expect(
      store.saveMediaStream(stream, "text/plain", subdir, 1024, "publication.txt"),
    ).rejects.toBe(injectedError);

    expect(stagedBytes).toEqual(input);
    await expect(fs.readdir(path.join(store.getMediaDir(), subdir))).resolves.toEqual([]);
  });
});
