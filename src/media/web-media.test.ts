import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createImageProcessor,
  readImageMetadataFromHeader,
  resizeToJpeg,
} from "./media-services.js";
import { encodePngRgba, fillPixel } from "./png-encode.js";

let media: typeof import("./web-media.js");
type MediaOptions = Exclude<Parameters<typeof media.loadWebMedia>[1], number | undefined>;
const suiteDirs = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TINY_PNG = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 });
const IMAGE_LIMITS = {
  models: [
    { maxSidePx: 32, preferredSidePx: 32 },
    { maxSidePx: 64, preferredSidePx: 64 },
  ],
};
let fixtureRoot = "";
let tinyPngFile = "";
let stateDir = "";
let workspaceDir = "";

async function writeFile(name: string, body: Buffer | string, root = fixtureRoot) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return file;
}

function localOptions(overrides: MediaOptions = {}): MediaOptions {
  return { maxBytes: 1024 * 1024, localRoots: [fixtureRoot], ...overrides };
}

function remoteOptions(
  body: BodyInit,
  headers: HeadersInit,
  overrides: MediaOptions = {},
): MediaOptions {
  return {
    fetchImpl: vi.fn(async () => new Response(body, { headers })),
    ssrfPolicy: { allowedHostnames: ["example.test"] },
    ...overrides,
  };
}

function loadWithHostRead(file: string) {
  return media.loadWebMedia(file, {
    maxBytes: 1024 * 1024,
    localRoots: "any",
    readFile: (source) => fs.readFile(source),
    hostReadCapability: true,
  });
}

async function expectAccessError(promise: Promise<unknown>, code = "path-not-allowed") {
  await expect(promise).rejects.toBeInstanceOf(media.LocalMediaAccessError);
  await expect(promise).rejects.toMatchObject({ code });
}

async function inState(run: (root: string) => Promise<void>, parent?: string) {
  const root = tempDirs.make("web-media-state-", parent);
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, () => run(root));
}

async function stageHtml(body = Buffer.from("<!doctype html><h1>report</h1>")) {
  const { saveMediaBuffer } = await import("./store.js");
  const saved = await saveMediaBuffer(body, "text/html", "outbound", 1024 * 1024, "report.html");
  return { path: saved.path, body };
}

function colorBlockPng(size: number, transparent = false) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const center = x >= size / 4 && x < (size * 3) / 4 && y >= size / 4 && y < (size * 3) / 4;
      fillPixel(
        pixels,
        x,
        y,
        size,
        center ? 230 : 30,
        center ? 40 : 110,
        center ? 35 : 220,
        transparent && !center ? 96 : undefined,
      );
    }
  }
  return encodePngRgba(pixels, size, size);
}

function jpegDimensions(buffer: Buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = expectDefined(buffer[offset + 1], "JPEG marker");
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const length = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error("JPEG dimensions not found");
}

async function xlsmFixture() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
  );
  zip.file(
    "xl/workbook.xml",
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

beforeAll(async () => {
  media = await import("./web-media.js");
  fixtureRoot = suiteDirs.make("web-media-core-", resolvePreferredOpenClawTmpDir());
  tinyPngFile = await writeFile("tiny.png", TINY_PNG);
  workspaceDir = path.join(fixtureRoot, "workspace");
  await writeFile("chart.png", TINY_PNG, workspaceDir);
  stateDir = resolveStateDir();
  await fs.mkdir(path.join(stateDir, "media", "outbound"), { recursive: true });
  await writeFile("canvas/documents/cv_test/collection.media/tiny.png", TINY_PNG, stateDir);
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  resetPluginRuntimeStateForTest();
});

afterAll(async () => {
  try {
    await fs.rm(path.join(stateDir, "canvas/documents/cv_test"), { recursive: true, force: true });
  } finally {
    vi.resetModules();
  }
});

describe("loadWebMedia", () => {
  it("loads encoded uppercase file URLs from reply directives without stripping ordinary UUID filenames", async () => {
    const fileName = "café 100% image---a1b2c3d4-5678-90ab-cdef-1234567890ab.png";
    const file = await writeFile(fileName, TINY_PNG);
    const url = pathToFileURL(file).href.replace(/^file:\/\//u, "FILE:");
    const reply = parseReplyDirectives(`Here is your image.\nMEDIA:${url}`);
    expect(reply.text).toBe("Here is your image.");
    expect(reply.mediaUrls).toHaveLength(1);
    const result = await media.loadWebMedia(
      expectDefined(reply.mediaUrls?.[0], "file URL"),
      localOptions(),
    );
    expect(result.buffer).toEqual(TINY_PNG);
    expect([result.fileName, result.contentType]).toEqual([fileName, "image/png"]);
  });

  it.each([
    { url: "FILE://attacker/share/evil.png", code: "invalid-file-url", beforeFs: true },
    {
      url: "\\\\attacker\\share\\evil.png",
      code: "network-path-not-allowed",
      beforeFs: true,
      windows: true,
    },
    {
      url: "/__openclaw__/canvas/documents/../collection.media/tiny.png",
      code: "path-not-allowed",
    },
    { url: "media://outbound/tiny.png", code: "path-not-allowed" },
    { url: "media://inbound/nested%2Ftiny.png", code: "invalid-path" },
  ])("rejects unsafe media path $url ($code)", async ({ url, code, beforeFs, windows }) => {
    const platform = windows
      ? vi.spyOn(process, "platform", "get").mockReturnValue("win32")
      : undefined;
    const realpath = vi.spyOn(fs, "realpath");
    try {
      await expectAccessError(
        media.loadWebMedia(
          url.startsWith("FILE:")
            ? expectDefined(parseReplyDirectives(`MEDIA:${url}`).mediaUrls?.[0], "file URL")
            : url,
          localOptions(),
        ),
        code,
      );
      if (beforeFs) {
        expect(realpath).not.toHaveBeenCalled();
      }
    } finally {
      platform?.mockRestore();
      realpath.mockRestore();
    }
  });

  it("surfaces Rastermill decode failures when optimization cannot produce a JPEG", async () => {
    await expect(media.optimizeImageToJpeg(Buffer.from("not an image"), 8)).rejects.toThrow(
      /Unable to determine image dimensions/,
    );
  });

  it("preserves oriented JPEG bytes with a stale HEIF filename and model limits", async () => {
    const jpeg = await resizeToJpeg({
      buffer: createSolidPngBuffer(32, 16, { r: 12, g: 34, b: 56 }),
      maxSide: 32,
      quality: 92,
      withoutEnlargement: true,
    });
    const orientation = Buffer.from(
      "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
      "hex",
    );
    const buffer = Buffer.concat([jpeg.subarray(0, 2), orientation, jpeg.subarray(2)]);
    expect(readImageMetadataFromHeader(buffer)).toEqual({ width: 16, height: 32 });
    const file = await writeFile("portrait.heif", buffer);
    const options = localOptions({
      imageCompression: { quality: "balanced", models: [{ maxSidePx: 32, maxPixels: 1024 }] },
    });
    const result = await media.loadWebMedia(file, options);
    expect(result.buffer).toEqual(buffer);
    expect([result.contentType, result.fileName]).toEqual(["image/jpeg", "portrait.heif"]);
  });

  it("preserves the explicit GIF byte cap for optimized remote media", async () => {
    const buffer = Buffer.alloc(10);
    buffer.write("GIF89a", 0, "ascii");
    buffer.writeUInt16LE(16, 6);
    buffer.writeUInt16LE(16, 8);
    const options = remoteOptions(Buffer.from(buffer), {
      "content-type": "image/gif",
      "content-length": String(buffer.length),
    });
    await expect(
      media.loadWebMedia("https://example.test/explicit-cap.gif", {
        ...options,
        maxBytes: buffer.length - 1,
      }),
    ).rejects.toThrow(/^GIF exceeds /);
    const result = await media.loadWebMedia("https://example.test/explicit-cap.gif", {
      ...options,
      maxBytes: buffer.length,
    });
    expect(result.buffer).toEqual(buffer);
    expect([result.contentType, result.fileName]).toEqual(["image/gif", "explicit-cap.gif"]);
  });

  it("resolves relative PNGs and enforces the strictest model dimensions", async () => {
    const file = "portrait.png";
    await writeFile(file, colorBlockPng(64));
    const options = localOptions({
      workspaceDir: fixtureRoot,
      imageCompression: { ...IMAGE_LIMITS, quality: "high" },
    });
    await expect(media.loadWebMediaRaw(file, options)).rejects.toThrow(
      /dimensions exceed model image limits/i,
    );
    const result = await media.loadWebMedia(file, options);
    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.fileName).toBe("portrait.jpg");
    expect(result.buffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpegDimensions(result.buffer)).toEqual({ width: 32, height: 32 });
  });

  it("resizes transparent WebP to PNG for a many-image turn", async () => {
    const webp = (await createImageProcessor().encode(colorBlockPng(64, true), { format: "webp" }))
      .data;
    const file = await writeFile("portrait.WebP", webp);
    const options = localOptions({ imageCompression: { ...IMAGE_LIMITS, imageCount: 8 } });
    const result = await media.loadWebMedia(file, options);
    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.fileName).toBe("portrait.png");
    expect(result.buffer.toString("ascii", 12, 16)).toBe("IHDR");
    expect(result.buffer.readUInt32BE(16)).toBe(32);
    expect(result.buffer.readUInt32BE(20)).toBe(32);
  });

  it.each([
    {
      raw: true,
      error: "Media exceeds 8B limit",
      imageCompression: { models: [{ maxBytes: 1024 }, {}, { maxBytes: 8 }] },
      maxBytes: 1024 * 1024,
    },
    { raw: false, error: /^Media could not be reduced below 8B \(got /, maxBytes: 8 },
  ])(
    "reports the effective image byte cap (raw=$raw)",
    async ({ raw, error, imageCompression, maxBytes }) => {
      await expect(
        (raw ? media.loadWebMediaRaw : media.loadWebMedia)(
          tinyPngFile,
          localOptions({ maxBytes, imageCompression }),
        ),
      ).rejects.toThrow(error);
    },
  );

  it("rejects oversized local media before an unbounded file-handle read", async () => {
    const maxBytes = 1.5 * 1024 * 1024;
    // Sparse and well past the cap, so an uncapped read would consume all of it.
    const file = await writeFile("oversized.bin", Buffer.alloc(0));
    await fs.truncate(file, maxBytes * 4);
    const unboundedRead = vi.fn(async () => {
      throw new Error("unbounded read invoked");
    });
    let observedOpen = false;
    let bytesRead = 0;
    __setFsSafeTestHooksForTest({
      afterOpen: (openedPath, handle) => {
        if (openedPath === file) {
          observedOpen = true;
          vi.spyOn(handle, "readFile").mockImplementation(unboundedRead);
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...args) => {
            const result = await read(...args);
            bytesRead += result.bytesRead;
            return result;
          });
        }
      },
    });
    await expect(media.loadWebMediaRaw(file, localOptions({ maxBytes }))).rejects.toThrow(
      "Media exceeds 1.50MB limit",
    );
    expect(observedOpen).toBe(true);
    expect(unboundedRead).not.toHaveBeenCalled();
    // fs-safe reads with FileHandle.read; a bounded read stops one byte past the cap.
    expect(bytesRead).toBeLessThanOrEqual(maxBytes + 1);
  });

  it.runIf(process.platform !== "win32")(
    "rejects an allowed ancestor symlink retargeted before open",
    async () => {
      const base = tempDirs.make("ancestor-race-", fixtureRoot);
      const allowed = path.join(base, "allowed");
      const inside = path.join(allowed, "inside");
      const outside = path.join(base, "outside");
      const alias = path.join(allowed, "slot");
      const file = path.join(alias, "image.png");
      await writeFile("image.png", TINY_PNG, inside);
      await writeFile("image.png", createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 0 }), outside);
      await fs.symlink(inside, alias);
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (openedPath === file) {
            await fs.rm(alias);
            await fs.symlink(outside, alias);
          }
        },
      });
      await expectAccessError(
        media.loadWebMediaRaw(file, { maxBytes: 1024 * 1024, localRoots: [allowed] }),
      );
    },
  );

  it("resolves home-relative paths through allowed local roots", async () => {
    await withEnvAsync({ OPENCLAW_HOME: fixtureRoot }, async () => {
      const result = await media.loadWebMedia(
        "~/workspace/chart.png",
        localOptions({ localRoots: [workspaceDir] }),
      );
      expect([result.kind, result.buffer]).toEqual(["image", TINY_PNG]);
    });
  });

  it.each([
    ["notes.txt", ",,,,,,,,,,\n", "text/plain"],
    ["legacy.csv", Buffer.from("caf\xe9,ni\xf1o\n", "latin1"), "text/csv"],
    ["report.html", "<!doctype html><title>Report</title><h1>Report</h1>\n", "text/html"],
  ] as const)("allows validated host-read %s", async (name, body, contentType) => {
    const result = await loadWithHostRead(await writeFile(name, body));
    expect(result).toMatchObject({ kind: "document", contentType });
  });

  it.each([
    ["debug.log", "plain text\n"],
    ["secret.pdf", "secret"],
    ["report.html", "status,value\nok,1\n"],
    ["outside.html", "<!doctype html><h1>outside</h1>", true],
    [
      "prefix-tail.csv",
      Buffer.concat([
        Buffer.from(`name,value\n${"row,1\n".repeat(1400)}`),
        Buffer.from([0x00, 0xff, 0x10, 0x80]),
      ]),
    ],
    ["bom-binary.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(9000, 0xff)])],
    [
      "alternating-high.csv",
      Buffer.from(Array.from({ length: 9000 }, (_, index) => (index % 2 === 0 ? 0x41 : 0xff))),
    ],
  ] as const)("rejects unsafe host-read document %s", async (name, body, outside?: true) => {
    if (name === "prefix-tail.csv") {
      expect(body.length - 4).toBeGreaterThan(8192);
    }
    await expectAccessError(
      loadWithHostRead(
        await writeFile(name, body, outside ? tempDirs.make("html-outside-") : fixtureRoot),
      ),
    );
  });

  it("admits explicitly published HTML without inventing generated provenance", async () => {
    const root = tempDirs.make("html-publication-");
    const body = Buffer.from("<!doctype html><h1>Final report</h1>");
    const file = await writeFile("report.html", body, root);
    const options = {
      localRoots: [root],
      readFile: (source: string) => fs.readFile(source),
      hostReadCapability: true,
      htmlPublication: "explicit" as const,
    };
    const result = await media.loadWebMedia(file, options);
    expect(result.buffer).toEqual(body);
    expect(result.contentType).toBe("text/html");
    expect(result.trustedGeneratedHtmlSource).toBeUndefined();
    await expectAccessError(loadWithHostRead(file));
    await expect(
      media.loadWebMedia(file, { ...options, maxBytes: body.length - 1 }),
    ).rejects.toThrow(/exceeds.*limit/i);
    const deniedRead = vi.fn(options.readFile);
    await expectAccessError(
      media.loadWebMedia(file, { ...options, localRoots: [workspaceDir], readFile: deniedRead }),
    );
    expect(deniedRead).not.toHaveBeenCalled();
  });

  it.each([
    { name: "not-html", body: Buffer.from("status,value\nok,1\n") },
    { name: "binary", body: Buffer.from([0, 0xff, 0x10, 0x80]) },
  ])("rejects $name bytes during explicit HTML publication", async ({ body }) => {
    const root = tempDirs.make("html-publication-invalid-");
    const file = await writeFile("report.html", body, root);
    await expectAccessError(
      media.loadWebMedia(file, {
        localRoots: [root],
        readFile: (source) => fs.readFile(source),
        hostReadCapability: true,
        htmlPublication: "explicit",
      }),
    );
  });

  it("keeps the host-read XLSM root boundary and byte limit", async () => {
    const body = await xlsmFixture();
    const file = await writeFile("bounded.xlsm", body);
    const readFile = vi.fn((source: string) => fs.readFile(source));
    await expectAccessError(
      media.loadWebMedia(file, { localRoots: [workspaceDir], readFile, hostReadCapability: true }),
    );
    expect(readFile).not.toHaveBeenCalled();
    await expect(
      media.loadWebMedia(file, {
        maxBytes: body.length - 1,
        localRoots: [fixtureRoot],
        readFile,
        hostReadCapability: true,
      }),
    ).rejects.toThrow(/exceeds.*limit/i);
  });

  it("allows exact marked outbound HTML bytes and rejects same-size replacements", async () => {
    await inState(async () => {
      const original = Buffer.from("<!doctype html><h1>A</h1>");
      const replacement = Buffer.from("<!doctype html><h1>B</h1>");
      expect(replacement.length).toBe(original.length);
      const saved = await stageHtml(original);
      await media.markTrustedGeneratedHtmlPath(saved.path, original);
      const allowed = await loadWithHostRead(saved.path);
      expect(allowed.buffer).toEqual(original);
      expect(allowed.fileName).toBe("report.html");
      expect(allowed.trustedGeneratedHtmlSource).toBe(true);
      await fs.writeFile(saved.path, replacement);
      await expectAccessError(loadWithHostRead(saved.path));
    });
  });

  it("requires provenance even when outbound staging is under the trusted temp root", async () => {
    await inState(async () => {
      const saved = await stageHtml();
      expect(path.resolve(saved.path)).toContain(path.resolve(resolvePreferredOpenClawTmpDir()));
      await expectAccessError(loadWithHostRead(saved.path));
    }, resolvePreferredOpenClawTmpDir());
  });

  it("keeps HTML provenance when filesystem inspection fails transiently", async () => {
    await inState(async () => {
      const saved = await stageHtml();
      await media.markTrustedGeneratedHtmlPath(saved.path, saved.body);
      const lstat = vi
        .spyOn(fs, "lstat")
        .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EMFILE" }));
      try {
        await media.pruneStaleTrustedGeneratedHtmlMarkers();
      } finally {
        lstat.mockRestore();
      }
      expect((await loadWithHostRead(saved.path)).buffer).toEqual(saved.body);
    });
  });

  it("prunes more stale HTML markers than one SQLite parameter batch", async () => {
    await inState(async (root) => {
      const { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
        await import("../infra/kysely-sync.js");
      const { openOpenClawStateDatabase, runOpenClawStateWriteTransaction } =
        await import("../state/openclaw-state-db.js");
      type ProvenanceDb = {
        outbound_media_provenance: {
          realpath: string;
          kind: string;
          version: number;
          sha256: string;
          size_bytes: number;
          created_at_ms: number;
        };
      };
      runOpenClawStateWriteTransaction(({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ProvenanceDb>(db)
            .insertInto("outbound_media_provenance")
            .values(
              Array.from({ length: 1_001 }, (_, index) => ({
                realpath: path.join(root, `missing-${index}.html`),
                kind: "trusted-generated-html",
                version: 1,
                sha256: "0".repeat(64),
                size_bytes: 1,
                created_at_ms: 1,
              })),
            ),
        );
      });
      await media.pruneStaleTrustedGeneratedHtmlMarkers();
      const { db } = openOpenClawStateDatabase();
      const count = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<ProvenanceDb>(db)
          .selectFrom("outbound_media_provenance")
          .select(({ fn }) => fn.countAll<number>().as("count")),
      );
      expect(Number(count?.count)).toBe(0);
    });
  });

  it("refuses to mark paths outside outbound staging", async () => {
    const file = await writeFile(
      "report.html",
      "<!doctype html><h1>outside</h1>",
      tempDirs.make("marker-outside-"),
    );
    await expect(media.markTrustedGeneratedHtmlPath(file, await fs.readFile(file))).rejects.toThrow(
      /outside outbound staging/i,
    );
  });

  it.each(["symlink", "hardlink"] as const)(
    "rejects a trusted HTML %s to an outside file",
    async (kind) => {
      const root = tempDirs.make("html-outside-", path.dirname(resolvePreferredOpenClawTmpDir()));
      const outside = await writeFile(
        "report.html",
        "<!doctype html><title>Outside</title><body>secret</body>\n",
        root,
      );
      const link = path.join(fixtureRoot, `${kind}-report.html`);
      try {
        if (kind === "symlink") {
          await fs.symlink(outside, link);
        } else {
          await fs.link(outside, link);
        }
      } catch (error) {
        if (
          (kind === "symlink" && (error as NodeJS.ErrnoException).code === "EPERM") ||
          (kind === "hardlink" && (error as NodeJS.ErrnoException).code === "EXDEV")
        ) {
          return;
        }
        throw error;
      }
      try {
        await expectAccessError(loadWithHostRead(link));
      } finally {
        await fs.rm(link, { force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    [2, "invalid-path"],
    [3, "path-not-allowed"],
  ] as const)(
    "rejects an inbound URI swapped to a hardlink on guarded open %s",
    async (swapOpen, code) => {
      const id = `signal-hardlink-race-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
      const file = await writeFile(`media/inbound/${id}`, "inside", stateDir);
      const outside = await writeFile(`${id}.outside`, "outside-secret", stateDir);
      let matchingOpens = 0;
      let linked = false;
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (path.basename(openedPath) !== id || ++matchingOpens !== swapOpen) {
            return;
          }
          await fs.rm(file);
          await fs.link(outside, file);
          linked = true;
        },
      });
      try {
        await expectAccessError(
          media.loadWebMediaRaw(`media://inbound/${id}`, { maxBytes: 1024 }),
          code,
        );
        expect(matchingOpens).toBe(swapOpen);
        expect(linked).toBe(true);
      } finally {
        await fs.rm(file, { force: true });
        await fs.rm(outside, { force: true });
      }
    },
  );

  it("accepts legacy MEDIA prefixes around inbound store URIs", async () => {
    const id = `signal-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const file = await writeFile(`media/inbound/${id}`, TINY_PNG, stateDir);
    try {
      const result = await media.loadWebMedia(`  media :  media://inbound/${id}`, {
        maxBytes: 1024 * 1024,
      });
      expect([result.kind, result.buffer, result.fileName]).toEqual(["image", TINY_PNG, id]);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("bounds explicit-cap image fetches at the optimization headroom", async () => {
    await expect(
      media.loadWebMedia(
        "https://example.test/huge.png",
        remoteOptions(
          new ReadableStream<Uint8Array>(),
          { "content-type": "image/png", "content-length": String(30 * 1024 * 1024) },
          { maxBytes: 5 * 1024 * 1024 },
        ),
      ),
    ).rejects.toThrow(/exceeds maxBytes/);
  });

  it("applies the shared remote read idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        },
      });
      const outcome = media
        .loadWebMediaRaw(
          "https://example.test/stalled.pdf",
          remoteOptions(
            body,
            { "content-type": "application/pdf" },
            { maxBytes: 1024 * 1024, readIdleTimeoutMs: 20 },
          ),
        )
        .then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      await vi.advanceTimersByTimeAsync(25);
      await expect(
        Promise.race([outcome, Promise.resolve({ status: "pending" as const })]),
      ).resolves.toMatchObject({ status: "rejected" });
      const result = await outcome;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.error)).toMatch(/stalled|no data received/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
