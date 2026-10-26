import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer, createTinyJpegBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errors.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createImageProcessor,
  getImageMetadata,
  readImageMetadataFromHeader,
  resizeToJpeg,
} from "./media-services.js";

let media: typeof import("./web-media.js");
type MediaOptions = Exclude<Parameters<typeof media.loadWebMedia>[1], number | undefined>;
const suiteDirs = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TINY_PNG = createSolidPngBuffer(1, 1, { r: 255, g: 255, b: 255 });
const IMAGE_MODELS = [
  { maxSidePx: 32, preferredSidePx: 32 },
  { maxSidePx: 64, preferredSidePx: 64 },
];
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
const loadLocal = (file: string, options: MediaOptions = {}) =>
  media.loadWebMedia(file, localOptions(options));
const hostOptions = (overrides: MediaOptions = {}): MediaOptions => ({
  localRoots: "any",
  readFile: (source) => fs.readFile(source),
  hostReadCapability: true,
  ...overrides,
});

const remoteOptions = (
  body: BodyInit,
  headers: HeadersInit,
  overrides: MediaOptions = {},
): MediaOptions => ({
  fetchImpl: vi.fn(async () => new Response(body, { headers })),
  ssrfPolicy: { allowedHostnames: ["example.test"] },
  ...overrides,
});

const loadWithHostRead = (file: string) =>
  media.loadWebMedia(file, hostOptions({ maxBytes: 1024 * 1024 }));

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

beforeAll(async () => {
  media = await import("./web-media.js");
  fixtureRoot = suiteDirs.make("web-media-core-", resolvePreferredOpenClawTmpDir());
  tinyPngFile = await writeFile("tiny.png", TINY_PNG);
  workspaceDir = path.join(fixtureRoot, "workspace");
  await writeFile("chart.png", TINY_PNG, workspaceDir);
  stateDir = resolveStateDir();
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  resetPluginRuntimeStateForTest();
});

afterAll(() => vi.resetModules());

describe("loadWebMedia", () => {
  it("loads encoded uppercase file URLs from reply directives without stripping ordinary UUID filenames", async () => {
    const fileName = "café 100% image---a1b2c3d4-5678-90ab-cdef-1234567890ab.png";
    const file = await writeFile(fileName, TINY_PNG);
    const url = pathToFileURL(file).href.replace(/^file:\/\//u, "FILE:");
    const reply = parseReplyDirectives(`Here is your image.\nMEDIA:${url}`);
    expect(reply.text).toBe("Here is your image.");
    expect(reply.mediaUrls).toHaveLength(1);
    const result = await loadLocal(expectDefined(reply.mediaUrls?.[0], "file URL"));
    expect(result.buffer).toEqual(TINY_PNG);
    expect([result.fileName, result.contentType]).toEqual([fileName, "image/png"]);
  });

  it.each([
    ["FILE://attacker/share/evil.png", "invalid-file-url", true, false],
    ["\\\\attacker\\share\\evil.png", "network-path-not-allowed", true, true],
    [
      "/__openclaw__/canvas/documents/../collection.media/tiny.png",
      "path-not-allowed",
      false,
      false,
    ],
    ["media://outbound/tiny.png", "path-not-allowed", false, false],
    ["media://inbound/nested%2Ftiny.png", "invalid-path", false, false],
  ] as const)("rejects unsafe path %s (%s)", async (url, code, beforeFs, windows) => {
    const platform = windows
      ? vi.spyOn(process, "platform", "get").mockReturnValue("win32")
      : undefined;
    const realpath = vi.spyOn(fs, "realpath");
    try {
      await expectAccessError(
        loadLocal(
          url.startsWith("FILE:")
            ? expectDefined(parseReplyDirectives(`MEDIA:${url}`).mediaUrls?.[0], "file URL")
            : url,
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

  it("preserves oriented JPEG bytes and corrects a stale HEIF filename with model limits", async () => {
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
    await expect(getImageMetadata(buffer)).resolves.toEqual({ width: 16, height: 32 });
    const file = await writeFile("portrait.heif", buffer);
    const options = localOptions({
      imageCompression: { quality: "balanced", models: [{ maxSidePx: 32, maxPixels: 1024 }] },
    });
    const result = await media.loadWebMedia(file, options);
    expect(result.buffer).toEqual(buffer);
    expect([result.contentType, result.fileName]).toEqual(["image/jpeg", "portrait.jpg"]);
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
    await writeFile(file, createSolidPngBuffer(64, 64, { r: 230, g: 40, b: 35 }));
    const options = localOptions({
      workspaceDir: fixtureRoot,
      imageCompression: { models: IMAGE_MODELS, quality: "high" },
    });
    await expect(media.loadWebMediaRaw(file, options)).rejects.toThrow(
      /dimensions exceed model image limits/i,
    );
    const result = await media.loadWebMedia(file, options);
    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.fileName).toBe("portrait.jpg");
    expect(result.buffer.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await expect(getImageMetadata(result.buffer)).resolves.toEqual({ width: 32, height: 32 });
  });

  it("resizes transparent WebP to PNG for a many-image turn", async () => {
    const source = createSolidPngBuffer(64, 64, { r: 30, g: 110, b: 220, a: 96 });
    const webp = (await createImageProcessor().encode(source, { format: "webp" })).data;
    const file = await writeFile("portrait.WebP", webp);
    const result = await loadLocal(file, {
      imageCompression: { models: IMAGE_MODELS, imageCount: 8 },
    });
    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.fileName).toBe("portrait.png");
    expect(result.buffer.toString("ascii", 12, 16)).toBe("IHDR");
    expect(result.buffer.readUInt32BE(16)).toBe(32);
    expect(result.buffer.readUInt32BE(20)).toBe(32);
  });

  it.each([true, false])(
    "reconciles sniffed image names with optimizeImages=%s while preserving raw metadata",
    async (optimizeImages) => {
      const file = await writeFile("converted.webp", TINY_PNG);
      const options = localOptions({ optimizeImages });
      const result = await media.loadWebMedia(file, options);
      expect([result.contentType, result.fileName]).toEqual(["image/png", "converted.png"]);
      expect(result.buffer).toEqual(TINY_PNG);

      const raw = await media.loadWebMediaRaw(file, options);
      expect([raw.contentType, raw.fileName]).toEqual(["image/png", "converted.webp"]);
      expect(raw.buffer).toEqual(TINY_PNG);
    },
  );

  it.each([
    {
      fileName: String.raw`C:\fixtures\portrait.PNG`,
      contentType: "image/png",
      buffer: TINY_PNG,
      expectedName: "portrait.PNG",
    },
    {
      fileName: String.raw`C:\fixtures\portrait.JpEg`,
      contentType: "image/jpeg",
      buffer: createTinyJpegBuffer(),
      expectedName: "portrait.JpEg",
    },
  ])(
    "strips preserved image paths without changing matching aliases ($contentType)",
    async ({ fileName, contentType, buffer, expectedName }) => {
      const result = await media.optimizeImageBufferForWebMedia({
        fileName,
        contentType,
        buffer,
        maxBytes: 1024 * 1024,
      });
      expect(result.contentType).toBe(contentType);
      expect(result.fileName).toBe(expectedName);
      expect(result.buffer).toBe(buffer);
    },
  );

  it("preserves unknown image extensions", async () => {
    const result = await media.loadWebMedia(
      "https://example.test/portrait.mystery",
      remoteOptions(
        "unknown image bytes",
        { "content-type": "image/x-private-format" },
        { optimizeImages: false },
      ),
    );
    expect([result.kind, result.contentType, result.fileName]).toEqual([
      "image",
      "image/x-private-format",
      "portrait.mystery",
    ]);
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
    const unboundedRead = vi.fn(() => Promise.reject(new Error("unbounded read invoked")));
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

  it.runIf(process.platform !== "win32")("rejects pre-open ancestor symlink swaps", async () => {
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
  });

  it("resolves home-relative paths through allowed local roots", async () => {
    await withEnvAsync({ OPENCLAW_HOME: fixtureRoot }, async () => {
      const result = await loadLocal("~/workspace/chart.png", { localRoots: [workspaceDir] });
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
    [
      "prefix-tail.csv",
      Buffer.concat([
        Buffer.from(`name,value\n${"row,1\n".repeat(1400)}`),
        Buffer.from([0x00, 0xff, 0x10, 0x80]),
      ]),
    ],
    ["bom-binary.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(9000, 0xff)])],
    ["alternating-high.csv", Buffer.alloc(9000, Buffer.from([0x41, 0xff]))],
  ] as const)("rejects unsafe host-read document %s", async (name, body) => {
    if (name === "prefix-tail.csv") {
      expect(body.length - 4).toBeGreaterThan(8192);
    }
    await expectAccessError(loadWithHostRead(await writeFile(name, body)));
  });

  it("admits explicitly published HTML without inventing generated provenance", async () => {
    const root = tempDirs.make("html-publication-");
    const body = Buffer.from("<!doctype html><h1>Final report</h1>");
    const file = await writeFile("report.html", body, root);
    const options = hostOptions({ localRoots: [root], htmlPublication: "explicit" });
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
      media.loadWebMedia(file, hostOptions({ localRoots: [root], htmlPublication: "explicit" })),
    );
  });

  it("requires exact-byte provenance beneath the trusted temp root", async () => {
    await inState(async () => {
      const original = Buffer.from("<!doctype html><h1>A</h1>");
      const replacement = Buffer.from("<!doctype html><h1>B</h1>");
      expect(replacement.length).toBe(original.length);
      const saved = await stageHtml(original);
      expect(path.resolve(saved.path)).toContain(path.resolve(resolvePreferredOpenClawTmpDir()));
      await expectAccessError(loadWithHostRead(saved.path));
      await media.markTrustedGeneratedHtmlPath(saved.path, original);
      const allowed = await loadWithHostRead(saved.path);
      expect(allowed.buffer).toEqual(original);
      expect(allowed.fileName).toBe("report.html");
      expect(allowed.trustedGeneratedHtmlSource).toBe(true);
      await fs.writeFile(saved.path, replacement);
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
      type ProvenanceDb = Pick<DB, "outbound_media_provenance">;
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

  it.each([
    ["symlink", fs.symlink, "EPERM"],
    ["hardlink", fs.link, "EXDEV"],
  ] as const)(
    "rejects a trusted HTML %s to an outside file",
    async (_kind, linkFile, unavailableCode) => {
      const root = tempDirs.make("html-outside-", path.dirname(resolvePreferredOpenClawTmpDir()));
      const outside = await writeFile(
        "report.html",
        "<!doctype html><title>Outside</title><body>secret</body>\n",
        root,
      );
      const link = path.join(tempDirs.make("html-link-", fixtureRoot), "report.html");
      try {
        await linkFile(outside, link);
      } catch (error) {
        if (hasErrnoCode(error, unavailableCode)) {
          return;
        }
        throw error;
      }
      await expectAccessError(loadWithHostRead(link));
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
});
