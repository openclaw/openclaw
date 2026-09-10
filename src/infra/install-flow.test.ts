// Covers install archive extraction and existing install path resolution.
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "./install-flow.js";

describe("resolveExistingInstallPath", () => {
  it("returns resolved path and stat for existing files", async () => {
    await withTestDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const filePath = path.join(fixtureRoot, "plugin.tgz");
      await fs.writeFile(filePath, "archive");

      const result = await resolveExistingInstallPath(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.resolvedPath).toBe(filePath);
      expect(result.stat.isFile()).toBe(true);
    });
  });

  it("returns a path-not-found error for missing paths", async () => {
    await withTestDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const missing = path.join(fixtureRoot, "missing.tgz");

      const result = await resolveExistingInstallPath(missing);

      expect(result).toEqual({
        ok: false,
        error: `path not found: ${missing}`,
      });
    });
  });
});

describe("withExtractedArchiveRoot", () => {
  it("applies optional extraction limits before the callback and leaves installer defaults unchanged", async () => {
    await withTestDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const archivePath = path.join(fixtureRoot, "plugin.zip");
      const zip = new JSZip();
      const bytes = Buffer.alloc(32, 97);
      zip.file("package/data.bin", bytes);
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      const onExtracted = vi.fn(async (rootDir: string) => ({
        ok: true as const,
        bytes: await fs.readFile(path.join(rootDir, "data.bin")),
      }));
      const params = {
        archivePath,
        tempDirPrefix: "openclaw-install-flow-",
        timeoutMs: 1000,
        onExtracted,
      };
      await expect(
        withExtractedArchiveRoot({ ...params, limits: { maxEntryBytes: bytes.length - 1 } }),
      ).resolves.toEqual({
        ok: false,
        error:
          "failed to extract archive: ArchiveLimitError: archive entry extracted size exceeds limit",
      });
      expect(onExtracted).not.toHaveBeenCalled();
      await expect(withExtractedArchiveRoot(params)).resolves.toEqual({ ok: true, bytes });
      expect(onExtracted).toHaveBeenCalledOnce();
    });
  });

  it("extracts archive and passes root directory to callback", async () => {
    await withTestDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const archivePath = path.join(fixtureRoot, "plugin.zip");
      const zip = new JSZip();
      zip.file("package.json", '{"name":"example-plugin"}');
      // Without the requested marker, the resolver would choose this child instead.
      zip.file("assets/note.txt", "asset");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      let workspace = "";
      const onExtracted = vi.fn(async (rootDir: string) => {
        workspace = path.dirname(rootDir);
        expect(path.basename(workspace)).toMatch(/^openclaw-plugin-/);
        return {
          ok: true as const,
          manifest: await fs.readFile(path.join(rootDir, "package.json"), "utf8"),
        };
      });

      await expect(
        withExtractedArchiveRoot({
          archivePath,
          tempDirPrefix: "openclaw-plugin-",
          timeoutMs: 1000,
          rootMarkers: ["package.json"],
          onExtracted,
        }),
      ).resolves.toEqual({ ok: true, manifest: '{"name":"example-plugin"}' });
      expect(onExtracted).toHaveBeenCalledOnce();
      await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns extract failure when extraction throws", async () => {
    await withTestDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const archivePath = path.join(fixtureRoot, "plugin.txt");
      await fs.writeFile(archivePath, "not an archive");
      const onExtracted = vi.fn(async () => ({ ok: true as const }));
      await expect(
        withExtractedArchiveRoot({
          archivePath,
          tempDirPrefix: "openclaw-plugin-",
          timeoutMs: 1000,
          onExtracted,
        }),
      ).resolves.toEqual({
        ok: false,
        error: `failed to extract archive: Error: unsupported archive: ${archivePath}`,
      });
      expect(onExtracted).not.toHaveBeenCalled();
    });
  });

  it("returns root-resolution failure when archive layout is invalid", async () => {
    await withTestDir({ prefix: "openclaw-install-flow-" }, async (fixtureRoot) => {
      const archivePath = path.join(fixtureRoot, "plugin.zip");
      const zip = new JSZip();
      zip.file("note.txt", "no package directory or marker");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      const onExtracted = vi.fn(async () => ({ ok: true as const }));
      await expect(
        withExtractedArchiveRoot({
          archivePath,
          tempDirPrefix: "openclaw-plugin-",
          timeoutMs: 1000,
          onExtracted,
        }),
      ).resolves.toEqual({ ok: false, error: "Error: unexpected archive layout (dirs: )" });
      expect(onExtracted).not.toHaveBeenCalled();
    });
  });
});
