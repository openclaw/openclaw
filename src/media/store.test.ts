import "../test-utils/prepare-compiled-subprocesses.js";
// Media store tests cover persisted media records and local file storage.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isPathWithinBase } from "../../test/helpers/paths.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { expectSavedOriginalFilenameCase } from "./store-filename.test-support.js";

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
    } catch {
      // ignore cleanup failures in tests
    } finally {
      vi.resetModules();
    }
  });

  afterEach(() => {
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
      store.saveMediaBuffer(
        Buffer.alloc(size),
        "application/octet-stream",
        "fractional-buffer",
        maxBytes,
      ),
    ).rejects.toThrow(message);
  });

  const sourceErrors: {
    name: string;
    source: () => Promise<string>;
    expected: { code: string; name?: string; message?: string; cause?: unknown };
    message?: string;
    maxBytes?: number;
  }[] = [
    { name: "directory", source: async () => home, expected: { code: "not-file" } },
    {
      name: "fractional source limit",
      source: async () => {
        const source = path.join(home, "fractional-source.bin");
        await fs.writeFile(source, Buffer.alloc(1.5 * 1024 * 1024 + 1));
        return source;
      },
      maxBytes: 1.5 * 1024 * 1024,
      expected: {
        name: "SaveMediaSourceError",
        code: "too-large",
        message: "Media exceeds 1.50MB limit",
        cause: expect.any(Error),
      },
    },
  ];
  if (process.platform !== "win32") {
    sourceErrors.push({
      name: "symlink",
      source: async () => {
        const target = path.join(home, "sensitive.txt");
        const source = path.join(home, "symlink-source.txt");
        await fs.writeFile(target, "sensitive");
        await fs.symlink(target, source);
        return source;
      },
      expected: { code: "invalid-path" },
      message: "symlink",
    });
  }
  it.each(sourceErrors)("rejects $name sources with typed errors", async (testCase) => {
    const result = store.saveMediaSource(
      await testCase.source(),
      undefined,
      "outbound",
      testCase.maxBytes,
    );
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject(testCase.expected);
    if (testCase.message) {
      await expect(result).rejects.toThrow(testCase.message);
    }
  });

  it.each(["ENOENT", "ENOSPC"] as const)("handles buffer write failure %s", async (code) => {
    const segment = code === "ENOENT" ? "race-buffer" : "failed-buffer";
    const attempts: string[] = [];
    vi.doMock("@openclaw/fs-safe/store", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@openclaw/fs-safe/store")>();
      return {
        ...actual,
        fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
          const actualStore = actual.fileStore(options);
          return {
            ...actualStore,
            write: async (...args: Parameters<typeof actualStore.write>) => {
              if (args[0].includes(`${segment}/`)) {
                attempts.push(args[0]);
                if (code === "ENOSPC" || attempts.length === 1) {
                  if (code === "ENOENT") {
                    await fs.rm(path.dirname(actualStore.path(args[0])), {
                      recursive: true,
                      force: true,
                    });
                  }
                  throw Object.assign(new Error(code), { code });
                }
              }
              return await actualStore.write(...args);
            },
          };
        },
      };
    });
    try {
      const scoped = await importFreshModule<typeof import("./store.js")>(
        import.meta.url,
        `./store.js?scope=buffer-write-${code}`,
      );
      const result = scoped.saveMediaBuffer(Buffer.from("voice"), "audio/ogg", segment);
      if (code === "ENOENT") {
        const saved = await result;
        expect(attempts).toHaveLength(2);
        expect((await fs.stat(saved.path)).isFile()).toBe(true);
      } else {
        await expect(result).rejects.toBeInstanceOf(Error);
        await expect(result).rejects.toMatchObject({ code: "ENOSPC" });
        expect(attempts).toHaveLength(1);
        expect(path.basename(attempts[0] ?? "")).toMatch(/^[^/\\]+\.ogg$/);
        const entries = await fs
          .readdir(path.join(await scoped.ensureMediaDir(), segment))
          .catch(() => []);
        expect(entries).toStrictEqual([]);
      }
    } finally {
      vi.doUnmock("@openclaw/fs-safe/store");
    }
  });

  it("saves streams with detected extension without buffering first", async () => {
    const chunk = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const stream = (async function* () {
      yield chunk;
      chunk.fill(0);
    })();
    const saved = await store.saveMediaStream(
      stream,
      undefined,
      "stream-inbound",
      1024,
      "photo.bin",
    );

    expect(saved.id).toMatch(/^photo---[a-f0-9-]{36}\.jpg$/);
    expect(saved.size).toBe(4);
    expect(saved.contentType).toBe("image/jpeg");
    await expect(fs.readFile(saved.path)).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  });

  it("preserves the original generic extension of stored streams", async () => {
    const buffer = Buffer.from("custom binary");
    const saved = await store.saveMediaStream(
      Readable.from([buffer]),
      "application/octet-stream",
      "stream-inbound",
      1024,
      "report.CuStOm",
    );
    expect(store.extractOriginalFilename(saved.path)).toBe("report.CuStOm");
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
      expect(read.size).toBe(contents.length);
      expect(read.buffer.toString("utf8")).toBe(contents);
    }
  });

  it("retries local-source writes when cleanup prunes the target directory", async () => {
    const srcFile = path.join(home, "tmp-src-race.txt");
    const targetDir = path.join(await store.ensureMediaDir(), "race-source");
    await fs.writeFile(srcFile, "local file");
    const open = fs.open;
    let injectedEnoent = false;
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (
        !injectedEnoent &&
        typeof filePath === "string" &&
        filePath.startsWith(`${targetDir}${path.sep}`)
      ) {
        injectedEnoent = true;
        await fs.rm(targetDir, { recursive: true, force: true });
        throw Object.assign(new Error("missing dir"), { code: "ENOENT" });
      }
      return open(filePath, flags, mode);
    });
    const saved = await store.saveMediaSource(srcFile, undefined, "race-source");
    expect(injectedEnoent).toBe(true);
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("local file");
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
        [
          "",
          "inbound",
          "remote-cache/session-1/images",
          "remote-cache/session-1/docs",
          "prune-chain/session-prune/images",
        ].map((subdir) => store.saveMediaBuffer(Buffer.from("media"), "text/plain", subdir)),
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
        for (const subdir of [
          "remote-cache/session-1/images",
          "prune-chain/session-prune",
          "prune-chain",
        ]) {
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
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "outside");
      const past = Date.now() - 10_000;
      await fs.utimes(outsideFile, past / 1000, past / 1000);
      await fs.symlink(outsideDir, symlinkPath);

      await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

      const outsideStat = await fs.stat(outsideFile);
      const symlinkStat = await fs.lstat(symlinkPath);
      expect(outsideStat.isFile()).toBe(true);
      expect(symlinkStat.isSymbolicLink()).toBe(true);
    },
  );

  describe("saveMediaBuffer with originalFilename", () => {
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
    ] as const)("$name", async (testCase) => {
      await expectSavedOriginalFilenameCase(store, testCase);
    });
  });
});

describe("media store filesystem faults", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@openclaw/fs-safe/store");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function errnoError(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  it.each([
    {
      name: "standalone fs-safe not-found",
      error: () => new FsSafeError("not-found", "media target not found"),
      shouldRetry: false,
    },
    {
      name: "fs-safe not-found wrapping ENOENT",
      error: () =>
        new FsSafeError("not-found", "media target not found", {
          cause: errnoError("ENOENT"),
        }),
      shouldRetry: true,
    },
  ])("surfaces or retries $name according to its exact cause", async ({ error, shouldRetry }) => {
    const stateDir = tempDirs.make("openclaw-media-retry-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const segment = `retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const injectedError = error();
    let writeAttempts = 0;
    vi.doMock("@openclaw/fs-safe/store", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@openclaw/fs-safe/store")>();
      return {
        ...actual,
        fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
          const actualStore = actual.fileStore(options);
          return {
            ...actualStore,
            write: async (...args: Parameters<typeof actualStore.write>) => {
              if (args[0].includes(`${segment}/`) && writeAttempts++ === 0) {
                throw injectedError;
              }
              return await actualStore.write(...args);
            },
          };
        },
      };
    });

    const store = await importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      `./store.js?scope=retry-boundary-${segment}`,
    );
    const result = store.saveMediaBuffer(Buffer.from("voice"), "audio/ogg", segment);
    if (shouldRetry) {
      const saved = await result;
      await expect(fs.stat(saved.path)).resolves.toMatchObject({ size: 5 });
      expect(writeAttempts).toBe(2);
      return;
    }
    await expect(result).rejects.toBe(injectedError);
    expect(writeAttempts).toBe(1);
  });

  it("recovers a missing staging directory before consuming a stream", async () => {
    const stateDir = tempDirs.make("openclaw-media-stream-retry-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const subdir = "stream-before-open";
    const input = Buffer.from("media stream survives directory recovery");
    let consumptionStarted = false;
    const stream = (async function* () {
      consumptionStarted = true;
      yield input;
    })();
    const originalOpen = fs.open.bind(fs);
    let directoryPruned = false;
    let consumedBeforeRecovery: boolean | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (
        !directoryPruned &&
        typeof args[0] === "string" &&
        args[0].includes(`${path.sep}${subdir}${path.sep}`) &&
        args[1] === "wx"
      ) {
        consumedBeforeRecovery = consumptionStarted;
        await fs.rmdir(path.dirname(args[0]));
        directoryPruned = true;
      }
      return await originalOpen(...args);
    });

    const store = await importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      "./store.js?scope=stream-before-open",
    );
    const saved = await store.saveMediaStream(stream, "text/plain", subdir, 1024);

    expect(directoryPruned).toBe(true);
    expect(consumedBeforeRecovery).toBe(false);
    expect(saved.size).toBe(input.byteLength);
    await expect(fs.readFile(saved.path)).resolves.toEqual(input);
    await expect(fs.readdir(path.dirname(saved.path))).resolves.toEqual([saved.id]);
  });

  it("rejects publication failure without replaying a consumed stream", async () => {
    const stateDir = tempDirs.make("openclaw-media-stream-publication-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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

    const store = await importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      "./store.js?scope=stream-final-rename",
    );
    await expect(
      store.saveMediaStream(stream, "text/plain", subdir, 1024, "publication.txt"),
    ).rejects.toBe(injectedError);

    expect(stagedBytes).toEqual(input);
    await expect(fs.readdir(path.join(store.getMediaDir(), subdir))).resolves.toEqual([]);
  });

  it("fully persists a stream chunk after a positive short write", async () => {
    const stateDir = tempDirs.make("openclaw-media-short-write-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const input = Buffer.from("positive short write");
    const originalOpen = fs.open.bind(fs);
    let shortWriteObserved = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        typeof args[0] !== "string" ||
        !args[0].includes(`${path.sep}short-write-stream${path.sep}`) ||
        args[1] !== "wx"
      ) {
        return handle;
      }

      let injectShortWrite = true;
      const injectedHandle = Object.create(handle) as typeof handle;
      injectedHandle.close = handle.close.bind(handle);
      injectedHandle.write = (async (
        buffer: Buffer,
        offset = 0,
        length = buffer.byteLength - offset,
      ) => {
        const writeLength = injectShortWrite ? Math.max(1, Math.floor(length / 2)) : length;
        injectShortWrite = false;
        shortWriteObserved ||= writeLength < length;
        return await handle.write(buffer, offset, writeLength);
      }) as typeof handle.write;
      injectedHandle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
        const buffer =
          typeof data === "string"
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesWritten } = await injectedHandle.write(
            buffer,
            offset,
            buffer.byteLength - offset,
          );
          offset += bytesWritten;
        }
      }) as typeof handle.writeFile;
      return injectedHandle;
    });

    const store = await importFreshModule<typeof import("./store.js")>(
      import.meta.url,
      "./store.js?scope=positive-short-write",
    );
    const saved = await store.saveMediaStream(
      Readable.from([input]),
      "text/plain",
      "short-write-stream",
      1024,
    );

    expect(shortWriteObserved).toBe(true);
    expect(saved.size).toBe(input.byteLength);
    await expect(fs.readFile(saved.path)).resolves.toEqual(input);
  });
});

describe("playback cache", () => {
  let store: typeof import("./store.js");
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-playback-cache-");
    store = await import("./store.js");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  afterEach(async () => {
    await fs.rm(store.getMediaDir(), { recursive: true, force: true });
  });

  it("evicts oldest playback transcodes when insertion enforcement exceeds its byte budget", async () => {
    const mediaDir = await store.ensureMediaDir();
    const cacheDir = path.join(mediaDir, store.PLAYBACK_TRANSCODE_SUBDIR);
    await fs.mkdir(cacheDir, { recursive: true });
    const oldPath = path.join(cacheDir, "v2-old.mp4");
    const newPath = path.join(cacheDir, "v2-new.mp4");
    const sparseSize = (512 * 1024 * 1024) / 2;
    await Promise.all([fs.writeFile(oldPath, ""), fs.writeFile(newPath, "")]);
    await Promise.all([fs.truncate(oldPath, sparseSize), fs.truncate(newPath, sparseSize)]);
    const nowMs = Date.now();
    await fs.utimes(oldPath, (nowMs - 2_000) / 1000, (nowMs - 2_000) / 1000);
    await fs.utimes(newPath, (nowMs - 1_000) / 1000, (nowMs - 1_000) / 1000);

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
    await fs.mkdir(cacheDir, { recursive: true });
    const freshPath = path.join(cacheDir, "v2-fresh.m4a");
    const oldPath = path.join(cacheDir, "v2-expired.m4a");
    const transientPath = path.join(mediaDir, "expired-transient.m4a");
    await Promise.all([
      fs.writeFile(freshPath, "fresh"),
      fs.writeFile(oldPath, "old"),
      fs.writeFile(transientPath, "transient"),
    ]);
    const nowMs = Date.now();
    await fs.utimes(freshPath, (nowMs - 5 * 60_000) / 1000, (nowMs - 5 * 60_000) / 1000);
    const expiredMs = nowMs - 7 * 24 * 60 * 60 * 1000 - 1_000;
    await Promise.all([
      fs.utimes(oldPath, expiredMs / 1000, expiredMs / 1000),
      fs.utimes(transientPath, expiredMs / 1000, expiredMs / 1000),
    ]);

    await store.prunePlaybackTranscodeCache();

    await expect(fs.stat(freshPath)).resolves.toMatchObject({ size: 5 });
    await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(transientPath)).resolves.toMatchObject({ size: 9 });
  });
});
