import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, resolveArchiveKind, resolvePackedRootDir } from "./archive.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("archive utils", () => {
  it("detects archive kinds", () => {
    expect(resolveArchiveKind("/tmp/file.zip")).toBe("zip");
    expect(resolveArchiveKind("/tmp/file.tgz")).toBe("tar");
    expect(resolveArchiveKind("/tmp/file.tar.gz")).toBe("tar");
    expect(resolveArchiveKind("/tmp/file.tar")).toBe("tar");
    expect(resolveArchiveKind("/tmp/file.txt")).toBeNull();
  });

  it("extracts zip archives", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.zip");
    const extractDir = path.join(workDir, "extract");

    const zip = new JSZip();
    zip.file("package/hello.txt", "hi");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await fs.mkdir(extractDir, { recursive: true });
    await extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 });
    const rootDir = await resolvePackedRootDir(extractDir);
    const content = await fs.readFile(path.join(rootDir, "hello.txt"), "utf-8");
    expect(content).toBe("hi");
  });

  it("extracts tar archives", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.tar");
    const extractDir = path.join(workDir, "extract");
    const packageDir = path.join(workDir, "package");

    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "hello.txt"), "yo");
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);

    await fs.mkdir(extractDir, { recursive: true });
    await extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 });
    const rootDir = await resolvePackedRootDir(extractDir);
    const content = await fs.readFile(path.join(rootDir, "hello.txt"), "utf-8");
    expect(content).toBe("yo");
  });

  it("rejects zip entries with path traversal (zip slip)", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "malicious.zip");
    const extractDir = path.join(workDir, "extract");

    // Create a zip with a path traversal entry
    const zip = new JSZip();
    zip.file("../escaped.txt", "malicious content");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
    ).rejects.toThrow("zip entry escapes destination");

    // Verify the file was NOT written outside
    const escapedPath = path.join(workDir, "escaped.txt");
    await expect(fs.stat(escapedPath)).rejects.toThrow();
  });

  it("rejects zip entries targeting sibling directories (prefix bypass)", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "sibling.zip");
    const extractDir = path.join(workDir, "extract");
    const siblingDir = path.join(workDir, "extract2");

    // Create a zip that tries to write to a sibling directory
    // This exploits the old prefix-based check where /tmp/extract2 starts with /tmp/extract
    const zip = new JSZip();
    // Using relative path that resolves to sibling after normalization
    zip.file("../extract2/sibling.txt", "sibling content");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await fs.mkdir(extractDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });

    await expect(
      extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
    ).rejects.toThrow("zip entry escapes destination");

    // Verify nothing was written to sibling
    const siblingFile = path.join(siblingDir, "sibling.txt");
    await expect(fs.stat(siblingFile)).rejects.toThrow();
  });

  it("allows filenames starting with dots (e.g., ..evil)", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "dotfiles.zip");
    const extractDir = path.join(workDir, "extract");

    // Create a zip with legitimate filenames that start with ".."
    // These should NOT be rejected as path traversal
    const zip = new JSZip();
    zip.file("..evil", "not malicious, just oddly named");
    zip.file("...dots", "three dots");
    zip.file("package/..config", "nested dotfile");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await fs.mkdir(extractDir, { recursive: true });
    await extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 });

    // Verify the files were extracted
    const content = await fs.readFile(path.join(extractDir, "..evil"), "utf-8");
    expect(content).toBe("not malicious, just oddly named");
  });
});
