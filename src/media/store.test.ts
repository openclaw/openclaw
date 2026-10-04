// Media store tests cover persisted media records and local file storage.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer, createTinyJpegBuffer } from "../../test/helpers/image-fixtures.js";
import { isPathWithinBase } from "../../test/helpers/paths.js";
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

  it("allows callers to override the default source size limit", async () => {
    const sourcePath = path.join(home, "large-source.bin");
    await fs.writeFile(sourcePath, Buffer.alloc(6 * 1024 * 1024, 0x41));

    const saved = await store.saveMediaSource(sourcePath, undefined, "outbound", 8 * 1024 * 1024);

    expect(saved.size).toBe(6 * 1024 * 1024);
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

  it.each([
    {
      name: "normalizes original filename",
      contents: "name,value\none,1\n",
      contentType: "application/octet-stream",
      filename: "cafe\u0301.csv",
      hint: undefined,
      id: /^caf\u00e9---[a-f0-9-]{36}\.csv$/,
      mime: "text/csv",
    },
    {
      name: "preserves original generic extension",
      contents: "custom binary",
      contentType: "application/octet-stream",
      filename: "report.CuStOm",
      hint: undefined,
      id: undefined,
      mime: undefined,
    },
    {
      name: "prefers detected mime over mixed-case generic zip header",
      contents: "docx",
      contentType: "Application/Zip",
      filename: undefined,
      hint: "document.docx",
      id: /^[a-f0-9-]{36}\.docx$/,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ])("stream metadata: $name", async ({ contents, contentType, filename, hint, id, mime }) => {
    const buffer = Buffer.from(contents);
    const saved = await store.saveMediaStream(
      Readable.from([buffer]),
      contentType,
      "stream-inbound",
      1024,
      filename,
      hint,
    );
    if (id) {
      expect(saved.id).toMatch(id);
    }
    if (mime) {
      expect(saved.contentType).toBe(mime);
    }
    if (filename === "report.CuStOm") {
      expect(store.extractOriginalFilename(saved.path)).toBe(filename);
      await expect(fs.readFile(saved.path)).resolves.toEqual(buffer);
    }
  });

  it("rejects oversized streams before writing a final artifact", async () => {
    await expect(
      store.saveMediaStream(
        Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
        "application/octet-stream",
        "oversized-stream",
        7,
      ),
    ).rejects.toThrow("Media exceeds 7B limit");

    const targetDir = path.join(home, ".openclaw", "media", "oversized-stream");
    const entries = await fs.readdir(targetDir).catch(() => []);
    expect(entries).toStrictEqual([]);
  });

  it("saves buffers when the best-effort fsync step reports EPERM", async () => {
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const filePath = args[0];
      if (typeof filePath === "string" && filePath.includes(`${path.sep}fsync-eperm${path.sep}`)) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
        );
      }
      return handle;
    });

    const saved = await store.saveMediaBuffer(
      Buffer.from("docx"),
      "application/zip",
      "fsync-eperm",
    );

    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("docx");
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

  const buffers: {
    name: string;
    buffer: () => Buffer | Promise<Buffer>;
    contentType: string;
    filename?: string;
    mime: string;
    extension: string;
    id?: RegExp;
    checkSize?: boolean;
  }[] = [
    {
      name: "text size and extension",
      buffer: () => Buffer.from("hello"),
      contentType: "text/plain",
      mime: "text/plain",
      extension: ".txt",
      checkSize: true,
    },
    {
      name: "jpeg detection",
      buffer: createTinyJpegBuffer,
      contentType: "image/jpeg",
      mime: "image/jpeg",
      extension: ".jpg",
    },
    {
      name: "generic CSV detection",
      buffer: () => Buffer.from("name,value\none,1\n"),
      contentType: "application/octet-stream",
      filename: "report.csv",
      mime: "text/csv",
      extension: ".csv",
      id: /^report---.+\.csv$/,
    },
    {
      name: "generic mixed-case extension",
      buffer: () => Buffer.from("custom binary"),
      contentType: "application/octet-stream",
      filename: "report.CuStOm",
      mime: "application/octet-stream",
      extension: ".CuStOm",
      id: /^report---.+\.CuStOm$/,
    },
    {
      name: "mixed-case image header cannot disguise zip",
      buffer: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return await zip.generateAsync({ type: "nodebuffer" });
      },
      contentType: "IMAGE/PNG",
      filename: "fake.png",
      mime: "application/zip",
      extension: ".zip",
      id: /^fake---[a-f0-9-]{36}\.zip$/,
    },
  ];
  it.each(buffers)("buffer metadata: $name", async (testCase) => {
    const buffer = await testCase.buffer();
    const saved = await store.saveMediaBuffer(
      buffer,
      testCase.contentType,
      "inbound",
      5 * 1024 * 1024,
      testCase.filename,
    );
    expect(saved.contentType).toBe(testCase.mime);
    expect(saved.path.endsWith(testCase.extension)).toBe(true);
    if (testCase.id) {
      expect(path.basename(saved.path)).toMatch(testCase.id);
    }
    if (testCase.checkSize) {
      expect((await fs.stat(saved.path)).size).toBe(buffer.length);
    }
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

  it.each([
    {
      filename: "tmp-src.txt",
      contents: async () => Buffer.from("local file"),
      mime: "text/plain",
      extension: ".txt",
    },
    {
      filename: "sheet.xlsx",
      contents: async () => Buffer.from("not really an xlsx"),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
    },
    {
      filename: "image-wrong.bin",
      contents: () => createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 }),
      mime: "image/png",
      extension: ".png",
    },
    {
      filename: "sheet.bin",
      contents: async () => {
        const zip = new JSZip();
        zip.file(
          "[Content_Types].xml",
          '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        );
        zip.file("xl/workbook.xml", "<workbook/>");
        return await zip.generateAsync({ type: "nodebuffer" });
      },
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
    },
  ])(
    "saves local $filename with detected metadata",
    async ({ filename, contents, mime, extension }) => {
      const buffer = await contents();
      const source = path.join(home, filename);
      await fs.writeFile(source, buffer);
      const saved = await store.saveMediaSource(source);
      expect(saved.contentType).toBe(mime);
      expect(path.extname(saved.path)).toBe(extension);
      expect(saved.size).toBe(buffer.length);
      expect((await fs.stat(saved.path)).isFile()).toBe(true);
      await expect(fs.readFile(saved.path)).resolves.toEqual(buffer);
    },
  );

  it("prefers header mime extension when sniffed mime lacks mapping", async () => {
    vi.doMock("@openclaw/media-core/mime", async () => {
      const actual = await vi.importActual<typeof import("@openclaw/media-core/mime")>(
        "@openclaw/media-core/mime",
      );
      return {
        ...actual,
        detectMime: vi.fn(async () => "audio/opus"),
      };
    });

    try {
      const storeWithMock = await importFreshModule<typeof import("./store.js")>(
        import.meta.url,
        "./store.js?scope=sniffed-mime-header-extension",
      );
      const saved = await storeWithMock.saveMediaBuffer(
        Buffer.from("fake-audio"),
        "audio/ogg; codecs=opus",
      );
      expect(path.extname(saved.path)).toBe(".ogg");
      expect(saved.path.startsWith(home)).toBe(true);
    } finally {
      vi.doUnmock("@openclaw/media-core/mime");
    }
  });

  describe("extractOriginalFilename", () => {
    it.each([
      {
        name: "handles uppercase UUID pattern",
        filename: "Document---A1B2C3D4-E5F6-7890-ABCD-EF1234567890.docx",
        expected: "Document.docx",
        basePath: "/media/inbound",
      },
      {
        name: "falls back to basename for UUID-only filenames",
        filename: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        expected: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        basePath: "/path",
      },
      {
        name: "falls back to basename for invalid UUID suffixes",
        filename: "foo---bar.txt",
        expected: "foo---bar.txt",
      },
      {
        name: "extracts from Windows paths on non-Windows hosts",
        filename: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        expected: "report.pdf",
        basePath: String.raw`C:\media\inbound`,
      },
    ] as const)("$name", ({ filename, expected, basePath }) => {
      expect(store.extractOriginalFilename(`${basePath ?? "/path/to"}/${filename}`)).toBe(expected);
    });
  });

  describe("saveMediaBuffer with originalFilename", () => {
    it.each([
      {
        name: "embeds original filename in stored path when provided",
        originalFilename: "report.txt",
        expectedIdPattern: /^report---[a-f0-9-]{36}\.txt$/,
        expectedExtractedFilename: "report.txt",
      },
      {
        name: "strips Windows-invalid and underscores non-portable characters",
        originalFilename: "my <file>:test!.txt",
        expectedIdPattern: /^my_filetest---[a-f0-9-]{36}\.txt$/,
      },
      {
        name: "normalizes letters joined by filename sanitization",
        originalFilename: "\u1100?\u1161.txt",
        expectedIdPattern: /^\uac00---[a-f0-9-]{36}\.txt$/,
        expectedExtractedFilename: "\uac00.txt",
      },
      {
        name: "composes Unicode before applying the filename cap",
        originalFilename: `${"a".repeat(59)}\u1100\u1161.txt`,
        expectedIdPattern: /^a{59}\uac00---[a-f0-9-]{36}\.txt$/,
        expectedExtractedFilename: `${"a".repeat(59)}\uac00.txt`,
      },
      {
        name: "truncates long original filenames",
        originalFilename: `${"a".repeat(100)}.txt`,
        expectedIdPattern: /^a{1,60}---[a-f0-9-]{36}\.txt$/,
      },
      {
        name: "does not split supplementary-plane letters at the filename cap",
        originalFilename: `${"a".repeat(59)}𐐀.txt`,
        expectedIdPattern: /^a{59}---[a-f0-9-]{36}\.txt$/,
      },
      {
        name: "falls back to UUID-only when the original basename is blank",
        originalFilename: "   .txt",
        expectedIdPattern: /^[a-f0-9-]{36}\.txt$/,
        expectUuidOnly: true,
      },
      {
        name: "falls back to UUID-only when the original basename has only invalid characters",
        originalFilename: "<>:\u0001.txt",
        expectedIdPattern: /^[a-f0-9-]{36}\.txt$/,
        expectUuidOnly: true,
      },
      {
        name: "preserves an original basename matching the sanitizer default",
        originalFilename: "file.txt",
        expectedIdPattern: /^file---[a-f0-9-]{36}\.txt$/,
        expectedExtractedFilename: "file.txt",
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
