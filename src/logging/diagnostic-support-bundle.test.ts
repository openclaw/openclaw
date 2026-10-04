// Diagnostic support bundle tests cover collected files and redaction in bundles.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonSupportBundleFile,
  textSupportBundleFile,
  writeSupportBundleDirectory,
  writeSupportBundleZip,
} from "./diagnostic-support-bundle.js";

describe("diagnostic support bundle helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-support-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes directory bundles with restrictive file permissions and byte inventory", async () => {
    const outputDir = path.join(tempDir, "bundle");
    const contents = await writeSupportBundleDirectory({
      outputDir,
      files: [
        jsonSupportBundleFile("manifest.json", { ok: true }),
        textSupportBundleFile("nested/summary.md", "hello"),
      ],
    });

    expect(contents).toEqual([
      {
        path: "manifest.json",
        mediaType: "application/json",
        bytes: Buffer.byteLength('{\n  "ok": true\n}\n', "utf8"),
      },
      {
        path: "nested/summary.md",
        mediaType: "text/plain; charset=utf-8",
        bytes: Buffer.byteLength("hello\n", "utf8"),
      },
    ]);
    expect(fs.statSync(path.join(outputDir, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(outputDir, "nested", "summary.md")).mode & 0o777).toBe(0o600);
  });

  it("keeps the target clean when directory publication fails", async () => {
    const outputDir = path.join(tempDir, "bundle");
    const writeFileSpy = vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      throw new Error("injected write failure");
    });
    try {
      await expect(
        writeSupportBundleDirectory({
          outputDir,
          files: [
            jsonSupportBundleFile("manifest.json", { ok: true }),
            textSupportBundleFile("events.jsonl", "event"),
          ],
        }),
      ).rejects.toThrow("injected write failure");
    } finally {
      writeFileSpy.mockRestore();
    }

    expect(fs.existsSync(outputDir)).toBe(false);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it("allows retry after a failed directory export", async () => {
    const outputDir = path.join(tempDir, "bundle");

    const realWriteFile = fsp.writeFile.bind(fsp);
    let attempt = 0;
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      attempt += 1;
      if (attempt === 2) {
        throw new Error("injected write failure");
      }
      return realWriteFile(file, data, options);
    });
    try {
      await expect(
        writeSupportBundleDirectory({
          outputDir,
          files: [
            jsonSupportBundleFile("manifest.json", { ok: true }),
            textSupportBundleFile("events.jsonl", "event"),
          ],
        }),
      ).rejects.toThrow("injected write failure");
    } finally {
      spy.mockRestore();
    }

    const contents = await writeSupportBundleDirectory({
      outputDir,
      files: [
        jsonSupportBundleFile("manifest.json", { ok: true }),
        textSupportBundleFile("events.jsonl", "event"),
      ],
    });
    expect(contents).toHaveLength(2);
    expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "events.jsonl"))).toBe(true);
  });

  it("rejects writing to an existing output directory", async () => {
    const outputDir = path.join(tempDir, "bundle");
    fs.mkdirSync(outputDir);

    await expect(
      writeSupportBundleDirectory({
        outputDir,
        files: [jsonSupportBundleFile("manifest.json", { ok: true })],
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("refuses to overwrite a destination that appears during staging", async () => {
    // A competing publisher creates the output directory between staging and
    // publication. The writer must refuse it (EEXIST) instead of silently
    // replacing it via POSIX directory rename.
    const outputDir = path.join(tempDir, "bundle");
    const realMkdir = fsp.mkdir.bind(fsp);
    let injected = false;
    const spy = vi.spyOn(fsp, "mkdir").mockImplementation(async (pathArg, options) => {
      // The exclusive claim is the non-recursive mkdir on the final output
      // directory; staging and member directories use recursive:true. When
      // our claim runs, a competing publisher has already won the destination:
      // create it (with a marker) first so the real claim rejects with EEXIST.
      if (
        !injected &&
        typeof pathArg === "string" &&
        path.resolve(pathArg) === outputDir &&
        !(options as { recursive?: boolean } | undefined)?.recursive
      ) {
        injected = true;
        await realMkdir(pathArg, { mode: 0o700 });
        fs.writeFileSync(path.join(pathArg, "competitor.txt"), "winner");
      }
      return realMkdir(pathArg, options);
    });
    try {
      await expect(
        writeSupportBundleDirectory({
          outputDir,
          files: [
            jsonSupportBundleFile("manifest.json", { ok: true }),
            textSupportBundleFile("events.jsonl", "event"),
          ],
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      spy.mockRestore();
    }

    // The competing bundle is untouched: no silent overwrite.
    expect(fs.readFileSync(path.join(outputDir, "competitor.txt"), "utf8")).toBe("winner");
    expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "events.jsonl"))).toBe(false);
    // No staging residue left behind.
    expect(fs.readdirSync(tempDir)).toEqual(["bundle"]);
  });

  it("never leaves a manifest-bearing partial bundle when publication is interrupted", async () => {
    // A crash during the entry-move phase cannot run catch/finally cleanup,
    // so the only reachable partial state must be "payload present, manifest
    // absent" — never a manifest that claims a complete bundle while payload
    // files are missing. The writer enforces this by publishing the manifest
    // last, independent of the filesystem's readdir order.
    const outputDir = path.join(tempDir, "bundle");
    const stagingMarker = ".openclaw-bundle-";
    const realReaddir = fsp.readdir.bind(fsp);
    const realRename = fsp.rename.bind(fsp);
    // Force a readdir order with the manifest first to prove publication order
    // is enforced by the writer, not by the filesystem. The writer always calls
    // readdir with withFileTypes:true, so the spy reissues the same options.
    const readdirSpy = vi.spyOn(fsp, "readdir").mockImplementation(async (dirPath, options) => {
      const entries = await realReaddir(dirPath, {
        ...(options as object),
        withFileTypes: true,
      });
      const dirents = entries as fs.Dirent[];
      if (typeof dirPath === "string" && dirPath.includes(stagingMarker)) {
        const manifest = dirents.find((entry) => entry.name === "manifest.json");
        if (manifest) {
          return [manifest, ...dirents.filter((entry) => entry !== manifest)] as never;
        }
      }
      return dirents as never;
    });
    // Record the order in which entries are renamed into the final directory.
    const publishedNames: string[] = [];
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (typeof to === "string" && to.startsWith(outputDir)) {
        publishedNames.push(path.relative(outputDir, to));
      }
      return realRename(from, to);
    });
    try {
      await writeSupportBundleDirectory({
        outputDir,
        files: [
          jsonSupportBundleFile("manifest.json", { ok: true }),
          textSupportBundleFile("events.jsonl", "event"),
          textSupportBundleFile("summary.md", "summary"),
        ],
      });
    } finally {
      readdirSpy.mockRestore();
      renameSpy.mockRestore();
    }

    // The manifest is the completeness signal, so it must be the last entry
    // renamed into the destination. A crash before the final rename leaves a
    // manifest-less partial directory that readers correctly reject.
    expect(publishedNames[publishedNames.length - 1]).toBe("manifest.json");
    expect(publishedNames).toHaveLength(3);
  });

  it("rejects absolute and traversal bundle paths", async () => {
    expect(() => jsonSupportBundleFile("../escape.json", {})).toThrow(/Invalid bundle/u);
    expect(() => textSupportBundleFile("/tmp/escape.txt", "nope")).toThrow(/Invalid bundle/u);

    await expect(
      writeSupportBundleZip({
        outputPath: path.join(tempDir, "bundle.zip"),
        files: [{ path: "nested/../escape.txt", mediaType: "text/plain", content: "nope" }],
      }),
    ).rejects.toThrow(/Invalid bundle/u);
  });

  it("writes zip bundles through the same file model", async () => {
    const outputPath = path.join(tempDir, "bundle.zip");
    const published = await writeSupportBundleZip({
      outputPath,
      files: [jsonSupportBundleFile("manifest.json", { ok: true })],
    });

    expect(published.path).toBe(outputPath);
    expect(published.bytes).toBeGreaterThan(0);
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    expect(await zip.file("manifest.json")?.async("string")).toBe('{\n  "ok": true\n}\n');
    expect(fs.readdirSync(tempDir)).toEqual(["bundle.zip"]);
  });

  it("replaces an existing export with restrictive permissions", async () => {
    const outputPath = path.join(tempDir, "bundle.zip");
    fs.writeFileSync(outputPath, "previous export");
    fs.chmodSync(outputPath, 0o644);

    const published = await writeSupportBundleZip({
      outputPath,
      files: [jsonSupportBundleFile("manifest.json", { ok: true })],
    });

    expect(published.path).toBe(outputPath);
    // The staged replacement installs a fresh file instead of truncating in
    // place, so a permissive pre-existing mode cannot survive the overwrite.
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    expect(await zip.file("manifest.json")?.async("string")).toBe('{\n  "ok": true\n}\n');
    expect(fs.readdirSync(tempDir)).toEqual(["bundle.zip"]);
  });

  it("keeps the previous export when publication fails", async () => {
    const outputPath = path.join(tempDir, "bundle.zip");
    await writeSupportBundleZip({
      outputPath,
      files: [jsonSupportBundleFile("manifest.json", { ok: true })],
    });
    const priorBytes = fs.readFileSync(outputPath);

    const writeFileSpy = vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      fs.writeFileSync(file as string, "partial replacement");
      throw new Error("injected write failure");
    });
    try {
      await expect(
        writeSupportBundleZip({
          outputPath,
          files: [jsonSupportBundleFile("manifest.json", { ok: false })],
        }),
      ).rejects.toThrow("injected write failure");
    } finally {
      writeFileSpy.mockRestore();
    }

    expect(fs.readFileSync(outputPath)).toEqual(priorBytes);
    expect(fs.readdirSync(tempDir)).toEqual(["bundle.zip"]);
  });
});
