import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const realOs = await vi.importActual<typeof import("node:os")>("node:os");
const HOME = path.join(realOs.tmpdir(), "clawdbot-home-test");

vi.mock("node:os", () => ({
  default: { homedir: () => HOME, tmpdir: () => realOs.tmpdir() },
  homedir: () => HOME,
  tmpdir: () => realOs.tmpdir(),
}));

const store = await import("./store.js");

describe("media store", () => {
  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  it("creates and returns media directory", async () => {
    const dir = await store.ensureMediaDir();
    const normalized = path.normalize(dir);
    expect(normalized).toContain(
      `${path.sep}.clawdbot${path.sep}media`,
    );
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("saves buffers and enforces size limit", async () => {
    const buf = Buffer.from("hello");
    const saved = await store.saveMediaBuffer(buf, "text/plain");
    const savedStat = await fs.stat(saved.path);
    expect(savedStat.size).toBe(buf.length);
    expect(saved.contentType).toBe("text/plain");
    expect(saved.path.endsWith(".txt")).toBe(true);

    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    const savedJpeg = await store.saveMediaBuffer(jpeg, "image/jpeg");
    expect(savedJpeg.contentType).toBe("image/jpeg");
    expect(savedJpeg.path.endsWith(".jpg")).toBe(true);

    const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
    await expect(store.saveMediaBuffer(huge)).rejects.toThrow(
      "Media exceeds 5MB limit",
    );
  });

  it("copies local files and cleans old media", async () => {
    const srcFile = path.join(HOME, "tmp-src.txt");
    await fs.mkdir(HOME, { recursive: true });
    await fs.writeFile(srcFile, "local file");
    const saved = await store.saveMediaSource(srcFile);
    expect(saved.size).toBe(10);
    const savedStat = await fs.stat(saved.path);
    expect(savedStat.isFile()).toBe(true);
    expect(path.extname(saved.path)).toBe(".txt");

    // make the file look old and ensure cleanOldMedia removes it
    const past = Date.now() - 10_000;
    await fs.utimes(saved.path, past / 1000, past / 1000);
    await store.cleanOldMedia(1);
    await expect(fs.stat(saved.path)).rejects.toThrow();
  });

  it("sets correct mime for xlsx by extension", async () => {
    const xlsxPath = path.join(HOME, "sheet.xlsx");
    await fs.mkdir(HOME, { recursive: true });
    await fs.writeFile(xlsxPath, "not really an xlsx");

    const saved = await store.saveMediaSource(xlsxPath);
    expect(saved.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(path.extname(saved.path)).toBe(".xlsx");
  });

  it("renames media based on detected mime even when extension is wrong", async () => {
    const pngBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const bogusExt = path.join(HOME, "image-wrong.bin");
    await fs.writeFile(bogusExt, pngBytes);

    const saved = await store.saveMediaSource(bogusExt);
    expect(saved.contentType).toBe("image/png");
    expect(path.extname(saved.path)).toBe(".png");

    const buf = await fs.readFile(saved.path);
    expect(buf.equals(pngBytes)).toBe(true);
  });

  it("sniffs xlsx mime for zip buffers and renames extension", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    );
    zip.file("xl/workbook.xml", "<workbook/>");
    const fakeXlsx = await zip.generateAsync({ type: "nodebuffer" });
    const bogusExt = path.join(HOME, "sheet.bin");
    await fs.writeFile(bogusExt, fakeXlsx);

    const saved = await store.saveMediaSource(bogusExt);
    expect(saved.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(path.extname(saved.path)).toBe(".xlsx");
  });
});
