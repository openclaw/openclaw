import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createJpegBufferWithDimensions, createPngBufferWithDimensions } from "./test-helpers.js";

let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
const mediaRootTracker = createSuiteTempRootTracker({
  prefix: "web-media-core-",
  parentDir: resolvePreferredOpenClawTmpDir(),
});

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

let fixtureRoot = "";
let tinyPngFile = "";
let workspaceDir = "";
let workspacePngFile = "";
let stateDir = "";
let canvasPngFile = "";
let fakePdfFile = "";
let realPdfFile = "";
let oversizedJpegFile = "";
let fakeHeicFile = "";

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("./image-ops.js");
  vi.doUnmock("./mime.js");
  vi.doUnmock("./ffmpeg-exec.js");
});

beforeAll(async () => {
  ({ loadWebMedia } = await import("./web-media.js"));
  await mediaRootTracker.setup();
  fixtureRoot = await mediaRootTracker.make("case");
  fakePdfFile = path.join(fixtureRoot, "fake.pdf");
  realPdfFile = path.join(fixtureRoot, "real.pdf");
  tinyPngFile = path.join(fixtureRoot, "tiny.png");
  oversizedJpegFile = path.join(fixtureRoot, "oversized.jpg");
  fakeHeicFile = path.join(fixtureRoot, "tiny.heic");
  workspaceDir = path.join(fixtureRoot, "workspace");
  workspacePngFile = path.join(workspaceDir, "chart.png");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(fakePdfFile, "TOP_SECRET_TEXT", "utf8");
  await fs.writeFile(
    realPdfFile,
    Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"),
  );
  await fs.writeFile(tinyPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  await fs.writeFile(workspacePngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  await fs.writeFile(fakeHeicFile, Buffer.from(TINY_PNG_BASE64, "base64"));
  await fs.writeFile(
    oversizedJpegFile,
    createJpegBufferWithDimensions({ width: 6_000, height: 5_000 }),
  );
  stateDir = resolveStateDir();
  canvasPngFile = path.join(
    stateDir,
    "canvas",
    "documents",
    "cv_test",
    "collection.media",
    "tiny.png",
  );
  await fs.mkdir(path.dirname(canvasPngFile), { recursive: true });
  await fs.writeFile(canvasPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
});

afterAll(async () => {
  await mediaRootTracker.cleanup();
  if (stateDir) {
    await fs.rm(path.join(stateDir, "canvas", "documents", "cv_test"), {
      recursive: true,
      force: true,
    });
  }
});

describe("loadWebMedia", () => {
  function createLocalWebMediaOptions() {
    return {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
    };
  }

  async function expectRejectedWebMedia(
    url: string,
    expectedError: Record<string, unknown> | RegExp,
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined,
  ) {
    const restoreHandle = setup?.();
    try {
      if (expectedError instanceof RegExp) {
        await expect(loadWebMedia(url, createLocalWebMediaOptions())).rejects.toThrow(
          expectedError,
        );
        return;
      }
      await expect(loadWebMedia(url, createLocalWebMediaOptions())).rejects.toMatchObject(
        expectedError,
      );
    } finally {
      restoreHandle?.mockRestore?.();
      restoreHandle?.restore?.();
    }
  }

  async function expectRejectedWebMediaWithoutFilesystemAccess(params: {
    url: string;
    expectedError: Record<string, unknown> | RegExp;
    setup?: () => { restore?: () => void; mockRestore?: () => void } | undefined;
  }) {
    const realpathSpy = vi.spyOn(fs, "realpath");
    try {
      await expectRejectedWebMedia(params.url, params.expectedError, params.setup);
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  }

  async function expectLoadedWebMediaCase(url: string) {
    const result = await loadWebMedia(url, createLocalWebMediaOptions());
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  }

  async function loadDocumentWithHostRead(fileName: string, body: Buffer | string) {
    const textFile = path.join(fixtureRoot, fileName);
    await fs.writeFile(textFile, body);
    return loadWebMedia(textFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
  }

  it.each([
    {
      name: "allows localhost file URLs for local files",
      createUrl: () => {
        const fileUrl = pathToFileURL(tinyPngFile);
        fileUrl.hostname = "localhost";
        return fileUrl.href;
      },
    },
  ] as const)("$name", async ({ createUrl }) => {
    await expectLoadedWebMediaCase(createUrl());
  });

  it("rejects oversized pixel-count images before decode/resize backends run", async () => {
    const oversizedPngFile = path.join(fixtureRoot, "oversized.png");
    await fs.writeFile(
      oversizedPngFile,
      createPngBufferWithDimensions({ width: 8_000, height: 4_000 }),
    );

    await expect(loadWebMedia(oversizedPngFile, createLocalWebMediaOptions())).rejects.toThrow(
      /pixel input limit/i,
    );
  });

  it("preserves pixel-limit errors for oversized JPEG optimization", async () => {
    await expect(loadWebMedia(oversizedJpegFile, createLocalWebMediaOptions())).rejects.toThrow(
      /pixel input limit/i,
    );
  });

  it.each([
    {
      name: "rejects remote-host file URLs before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: { code: "invalid-file-url" },
    },
    {
      name: "rejects remote-host file URLs with the explicit error message before filesystem checks",
      url: "file://attacker/share/evil.png",
      expectedError: /remote hosts are not allowed/i,
    },
    {
      name: "rejects Windows network paths before filesystem checks",
      url: "\\\\attacker\\share\\evil.png",
      expectedError: { code: "network-path-not-allowed" },
      setup: () => vi.spyOn(process, "platform", "get").mockReturnValue("win32"),
    },
  ] as const)("$name", async (testCase) => {
    await expectRejectedWebMediaWithoutFilesystemAccess(testCase);
  });

  it("loads browser-style canvas media paths as managed local files", async () => {
    const result = await loadWebMedia(
      `${CANVAS_HOST_PATH}/documents/cv_test/collection.media/tiny.png`,
      { maxBytes: 1024 * 1024 },
    );
    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  describe("workspaceDir relative path resolution", () => {
    it("resolves a bare filename against workspaceDir", async () => {
      const result = await loadWebMedia("chart.png", {
        ...createLocalWebMediaOptions(),
        localRoots: [workspaceDir],
        workspaceDir,
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it("resolves a dot-relative path against workspaceDir", async () => {
      const result = await loadWebMedia("./chart.png", {
        ...createLocalWebMediaOptions(),
        localRoots: [workspaceDir],
        workspaceDir,
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it("resolves a MEDIA:-prefixed relative path against workspaceDir", async () => {
      const result = await loadWebMedia("MEDIA:chart.png", {
        ...createLocalWebMediaOptions(),
        localRoots: [workspaceDir],
        workspaceDir,
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it("leaves absolute paths unchanged when workspaceDir is set", async () => {
      const result = await loadWebMedia(workspacePngFile, {
        ...createLocalWebMediaOptions(),
        localRoots: [workspaceDir],
        workspaceDir: "/some/other/dir",
      });
      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
    });
  });

  it("rejects host-read text files outside local roots", async () => {
    const secretFile = path.join(fixtureRoot, "secret.txt");
    await fs.writeFile(secretFile, "secret", "utf8");
    await expect(
      loadWebMedia(secretFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects renamed host-read text files even when the extension looks allowed", async () => {
    const disguisedPdf = path.join(fixtureRoot, "secret.pdf");
    await fs.writeFile(disguisedPdf, "secret", "utf8");
    await expect(
      loadWebMedia(disguisedPdf, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("allows host-read CSV files", async () => {
    const csvFile = path.join(fixtureRoot, "data.csv");
    await fs.writeFile(csvFile, "name,value\nfoo,1\nbar,2\n", "utf8");
    const result = await loadWebMedia(csvFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/csv");
  });

  it("allows host-read Markdown files", async () => {
    const mdFile = path.join(fixtureRoot, "notes.md");
    await fs.writeFile(mdFile, "# Title\n\nSome **bold** text.\n", "utf8");
    const result = await loadWebMedia(mdFile, {
      maxBytes: 1024 * 1024,
      localRoots: "any",
      readFile: async (filePath) => await fs.readFile(filePath),
      hostReadCapability: true,
    });
    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("text/markdown");
  });

  it("rejects binary data disguised as a CSV file", async () => {
    const fakeCsv = path.join(fixtureRoot, "evil.csv");
    // Write ZIP magic bytes — file-type detects application/zip (not image, not CSV),
    // so it is rejected by the host-read policy rather than allowed as an image.
    await fs.writeFile(fakeCsv, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expect(
      loadWebMedia(fakeCsv, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it.each([
    { label: "CSV", fileName: "opaque.csv" },
    { label: "Markdown", fileName: "opaque.md" },
  ])("rejects opaque non-NUL binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    const opaqueBinary = Buffer.alloc(9000);
    for (let i = 0; i < opaqueBinary.length; i += 1) {
      opaqueBinary[i] = (i % 255) + 1;
    }
    await fs.writeFile(fakeTextFile, opaqueBinary);
    await expect(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it.each([
    { label: "CSV", fileName: "prefix-tail.csv" },
    { label: "Markdown", fileName: "prefix-tail.md" },
  ])(
    "rejects %s files with a text prefix and binary tail after the old sample window",
    async ({ fileName }) => {
      const fakeTextFile = path.join(fixtureRoot, fileName);
      const textPrefix = Buffer.from(`name,value\n${"row,1\n".repeat(1400)}`, "utf8");
      expect(textPrefix.length).toBeGreaterThan(8192);
      const binaryTail = Buffer.from([0x00, 0xff, 0x10, 0x80]);
      await fs.writeFile(fakeTextFile, Buffer.concat([textPrefix, binaryTail]));
      await expect(
        loadWebMedia(fakeTextFile, {
          maxBytes: 1024 * 1024,
          localRoots: "any",
          readFile: async (filePath) => await fs.readFile(filePath),
          hostReadCapability: true,
        }),
      ).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    },
  );

  it.each([
    {
      label: "CSV",
      fileName: "punctuation.csv",
      contentType: "text/csv",
      body: ",,,,,,,,,,\n",
    },
    {
      label: "Markdown",
      fileName: "punctuation.md",
      contentType: "text/markdown",
      body: "---\n***\n> > >\n",
    },
  ])(
    "loads valid punctuation-heavy %s files when host-read capability is enabled",
    async ({ fileName, contentType, body }) => {
      const result = await loadDocumentWithHostRead(fileName, Buffer.from(body, "utf8"));
      expect(result.kind).toBe("document");
      expect(result.contentType).toBe(contentType);
    },
  );

  it.each([
    {
      label: "CSV",
      fileName: "legacy.csv",
      contentType: "text/csv",
      body: Buffer.from("caf\xe9,ni\xf1o\n", "latin1"),
    },
    {
      label: "Markdown",
      fileName: "legacy.md",
      contentType: "text/markdown",
      body: Buffer.from("R\xe9sum\xe9\nni\xf1o\n", "latin1"),
    },
  ])(
    "loads valid single-byte encoded %s files when host-read capability is enabled",
    async ({ fileName, contentType, body }) => {
      const result = await loadDocumentWithHostRead(fileName, body);
      expect(result.kind).toBe("document");
      expect(result.contentType).toBe(contentType);
    },
  );

  it.each([
    { label: "CSV", fileName: "nul-padded.csv" },
    { label: "Markdown", fileName: "nul-padded.md" },
  ])("rejects NUL-padded binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // Alternating 0x00/0xFF — UTF-8 decode fails (0xFF is invalid UTF-8), then
    // hasSingleByteTextShape rejects because 0x00 bytes are control chars (< 0x20).
    const nulPadded = Buffer.alloc(9000);
    for (let i = 0; i < nulPadded.length; i += 1) {
      nulPadded[i] = i % 2 === 0 ? 0x00 : 0xff;
    }
    await fs.writeFile(fakeTextFile, nulPadded);
    await expect(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it.each([
    { label: "CSV", fileName: "bom-binary.csv" },
    { label: "Markdown", fileName: "bom-binary.md" },
  ])("rejects UTF-16 BOM-prefixed binary data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // UTF-16LE BOM + repeating 0xFF bytes: if UTF-16 decoding were attempted,
    // every byte pair would produce a printable code point and pass getTextStats.
    // With UTF-16 decoding removed, falls through to UTF-8 strict decode (throws
    // on 0xFF), then hasSingleByteTextShape rejects due to high-byte ratio > 30%.
    const bom = Buffer.from([0xff, 0xfe]);
    const garbage = Buffer.alloc(9000, 0xff);
    await fs.writeFile(fakeTextFile, Buffer.concat([bom, garbage]));
    await expect(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it.each([
    { label: "CSV", fileName: "alternating-high.csv" },
    { label: "Markdown", fileName: "alternating-high.md" },
  ])("rejects alternating ASCII/high-byte data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    // Alternating 0x41 ('A') and 0xFF — exactly 50% ASCII, 50% high bytes.
    // With the old 50% threshold hasSingleByteTextShape would accept this;
    // the tightened 70%/30% thresholds must reject it.
    const mixed = Buffer.alloc(9000);
    for (let i = 0; i < mixed.length; i += 1) {
      mixed[i] = i % 2 === 0 ? 0x41 : 0xff;
    }
    await fs.writeFile(fakeTextFile, mixed);
    await expect(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it.each([
    { label: "CSV", fileName: "high-bytes.csv" },
    { label: "Markdown", fileName: "high-bytes.md" },
  ])("rejects high-byte opaque data disguised as %s", async ({ fileName }) => {
    const fakeTextFile = path.join(fixtureRoot, fileName);
    const opaqueBinary = Buffer.alloc(9000);
    for (let i = 0; i < opaqueBinary.length; i += 1) {
      opaqueBinary[i] = 0xa0 + (i % 96);
    }
    await fs.writeFile(fakeTextFile, opaqueBinary);
    await expect(
      loadWebMedia(fakeTextFile, {
        maxBytes: 1024 * 1024,
        localRoots: "any",
        readFile: async (filePath) => await fs.readFile(filePath),
        hostReadCapability: true,
      }),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects traversal-style canvas media paths before filesystem access", async () => {
    await expect(
      loadWebMedia(`${CANVAS_HOST_PATH}/documents/../collection.media/tiny.png`),
    ).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("hydrates inbound media store URIs before allowed-root checks", async () => {
    const id = `signal-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await loadWebMedia(`media://inbound/${id}`, {
        maxBytes: 1024 * 1024,
      });

      expect(result.kind).toBe("image");
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.fileName).toBe(id);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("rejects unsupported media store URI locations", async () => {
    await expect(loadWebMedia("media://outbound/tiny.png")).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("rejects media store URI ids with encoded path separators", async () => {
    await expect(loadWebMedia("media://inbound/nested%2Ftiny.png")).rejects.toMatchObject({
      code: "invalid-path",
    });
  });

  it("rejects media store URIs without an id", async () => {
    await expect(loadWebMedia("media://inbound/")).rejects.toMatchObject({
      code: "invalid-path",
    });
  });

  it("normalizes HEIC local files to JPEG output", async () => {
    const result = await loadWebMedia(fakeHeicFile, createLocalWebMediaOptions());

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.fileName).toBe("tiny.jpg");
    expect(result.buffer[0]).toBe(0xff);
    expect(result.buffer[1]).toBe(0xd8);
  });

  it("converts parameterized HEIC mime types before JPEG optimization", async () => {
    const inputBuffer = Buffer.from("fake-heic");
    const convertedBuffer = Buffer.from("converted-jpeg-source");
    const optimizedBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const convertHeicToJpegMock = vi.fn().mockResolvedValueOnce(convertedBuffer);
    const resizeToJpegMock = vi.fn().mockResolvedValueOnce(optimizedBuffer);
    vi.doMock("./image-ops.js", async () => {
      const actual = await vi.importActual<typeof import("./image-ops.js")>("./image-ops.js");
      return {
        ...actual,
        convertHeicToJpeg: convertHeicToJpegMock,
        resizeToJpeg: resizeToJpegMock,
      };
    });
    const { optimizeImageToJpeg } = await importFreshModule<typeof import("./web-media.js")>(
      import.meta.url,
      "./web-media.js?scope=heic-mime-params",
    );

    const result = await optimizeImageToJpeg(inputBuffer, 1024, {
      contentType: "image/heic; charset=binary",
      fileName: "tiny.heic",
    });

    expect(convertHeicToJpegMock).toHaveBeenCalledWith(inputBuffer);
    expect(resizeToJpegMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: convertedBuffer,
        maxSide: 2048,
        quality: 80,
      }),
    );
    expect(result.buffer).toBe(optimizedBuffer);
  });

  it("converts HEIC files identified by extension even when the mime type is mislabeled", async () => {
    const inputBuffer = Buffer.from("fake-heic");
    const convertedBuffer = Buffer.from("converted-jpeg-source");
    const optimizedBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const convertHeicToJpegMock = vi.fn().mockResolvedValueOnce(convertedBuffer);
    const resizeToJpegMock = vi.fn().mockResolvedValueOnce(optimizedBuffer);
    vi.doMock("./image-ops.js", async () => {
      const actual = await vi.importActual<typeof import("./image-ops.js")>("./image-ops.js");
      return {
        ...actual,
        convertHeicToJpeg: convertHeicToJpegMock,
        resizeToJpeg: resizeToJpegMock,
      };
    });
    const { optimizeImageToJpeg } = await importFreshModule<typeof import("./web-media.js")>(
      import.meta.url,
      "./web-media.js?scope=heic-extension-fallback",
    );

    const result = await optimizeImageToJpeg(inputBuffer, 1024, {
      contentType: "application/octet-stream",
      fileName: "tiny.heic",
    });

    expect(convertHeicToJpegMock).toHaveBeenCalledWith(inputBuffer);
    expect(resizeToJpegMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: convertedBuffer,
        maxSide: 2048,
        quality: 80,
      }),
    );
    expect(result.buffer).toBe(optimizedBuffer);
  });

  it("relabels audio-only webm files as audio before delivery", async () => {
    const audioOnlyWebmFile = path.join(fixtureRoot, "voice.webm");
    await fs.writeFile(audioOnlyWebmFile, Buffer.from("fake-webm"));
    const detectMimeMock = vi.fn().mockResolvedValueOnce("video/webm");
    const runFfprobeMock = vi.fn().mockResolvedValueOnce("audio\n");
    vi.doMock("./mime.js", async () => {
      const actual = await vi.importActual<typeof import("./mime.js")>("./mime.js");
      return {
        ...actual,
        detectMime: detectMimeMock,
      };
    });
    vi.doMock("./ffmpeg-exec.js", async () => {
      const actual = await vi.importActual<typeof import("./ffmpeg-exec.js")>("./ffmpeg-exec.js");
      return {
        ...actual,
        runFfprobe: runFfprobeMock,
      };
    });
    const { loadWebMedia: loadFreshWebMedia } = await importFreshModule<
      typeof import("./web-media.js")
    >(import.meta.url, "./web-media.js?scope=audio-only-webm");

    const result = await loadFreshWebMedia(audioOnlyWebmFile, createLocalWebMediaOptions());

    expect(detectMimeMock).toHaveBeenCalledTimes(1);
    expect(runFfprobeMock).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("audio");
    expect(result.contentType).toBe("audio/webm");
  });

  it("does not probe remote webm URLs for stream metadata", async () => {
    const runFfprobeMock = vi.fn();
    const fetchRemoteMediaMock = vi
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("fake-remote-webm"), contentType: "video/webm" });
    vi.doMock("./fetch.js", async () => {
      const actual = await vi.importActual<typeof import("./fetch.js")>("./fetch.js");
      return {
        ...actual,
        fetchRemoteMedia: fetchRemoteMediaMock,
      };
    });
    vi.doMock("./ffmpeg-exec.js", async () => {
      const actual = await vi.importActual<typeof import("./ffmpeg-exec.js")>("./ffmpeg-exec.js");
      return {
        ...actual,
        runFfprobe: runFfprobeMock,
      };
    });
    const { loadWebMedia: loadFreshWebMedia } = await importFreshModule<
      typeof import("./web-media.js")
    >(import.meta.url, "./web-media.js?scope=remote-webm");

    const result = await loadFreshWebMedia(
      "https://example.com/voice.webm",
      createLocalWebMediaOptions(),
    );

    expect(fetchRemoteMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/voice.webm" }),
    );
    expect(runFfprobeMock).not.toHaveBeenCalled();
    expect(result.kind).toBe("video");
    expect(result.contentType).toBe("video/webm");
  });

  describe("host read capability", () => {
    it("rejects document uploads that only match by file extension", async () => {
      await expect(
        loadWebMedia(fakePdfFile, {
          maxBytes: 1024 * 1024,
          localRoots: [fixtureRoot],
          hostReadCapability: true,
        }),
      ).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    });

    it("still allows real PDF uploads detected from file content", async () => {
      const result = await loadWebMedia(realPdfFile, {
        maxBytes: 1024 * 1024,
        localRoots: [fixtureRoot],
        hostReadCapability: true,
      });

      expect(result.kind).toBe("document");
      expect(result.contentType).toBe("application/pdf");
      expect(result.fileName).toBe("real.pdf");
    });
  });
});
