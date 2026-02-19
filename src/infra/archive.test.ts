import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractArchive, resolveArchiveKind, resolvePackedRootDir } from "./archive.js";

let fixtureRoot = "";
let fixtureCount = 0;

async function makeTempDir(prefix = "case") {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
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

  it("rejects zip path traversal (zip slip)", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.zip");
    const extractDir = path.join(workDir, "a");

    const zip = new JSZip();
    zip.file("../b/evil.txt", "pwnd");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
    ).rejects.toThrow(/(escapes destination|absolute)/i);
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

  it("rejects tar path traversal (zip slip)", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.tar");
    const extractDir = path.join(workDir, "extract");
    const insideDir = path.join(workDir, "inside");
    await fs.mkdir(insideDir, { recursive: true });
    await fs.writeFile(path.join(workDir, "outside.txt"), "pwnd");

    await tar.c({ cwd: insideDir, file: archivePath }, ["../outside.txt"]);

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
    ).rejects.toThrow(/escapes destination/i);
  });

  it("rejects zip archives that exceed extracted size budget", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.zip");
    const extractDir = path.join(workDir, "extract");

    const zip = new JSZip();
    zip.file("package/big.txt", "x".repeat(64));
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({
        archivePath,
        destDir: extractDir,
        timeoutMs: 5_000,
        limits: { maxExtractedBytes: 32 },
      }),
    ).rejects.toThrow("archive extracted size exceeds limit");
  });

  it("rejects archives that exceed archive size budget", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.zip");
    const extractDir = path.join(workDir, "extract");

    const zip = new JSZip();
    zip.file("package/file.txt", "ok");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    const stat = await fs.stat(archivePath);

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({
        archivePath,
        destDir: extractDir,
        timeoutMs: 5_000,
        limits: { maxArchiveBytes: Math.max(1, stat.size - 1) },
      }),
    ).rejects.toThrow("archive size exceeds limit");
  });

  it("rejects tar archives that exceed extracted size budget", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.tar");
    const extractDir = path.join(workDir, "extract");
    const packageDir = path.join(workDir, "package");

    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "big.txt"), "x".repeat(64));
    await tar.c({ cwd: workDir, file: archivePath }, ["package"]);

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({
        archivePath,
        destDir: extractDir,
        timeoutMs: 5_000,
        limits: { maxExtractedBytes: 32 },
      }),
    ).rejects.toThrow("archive extracted size exceeds limit");
  });

  it("rejects tar entries with absolute extraction paths", async () => {
    const workDir = await makeTempDir();
    const archivePath = path.join(workDir, "bundle.tar");
    const extractDir = path.join(workDir, "extract");

    const inputDir = path.join(workDir, "input");
    const outsideFile = path.join(inputDir, "outside.txt");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(outsideFile, "owned");
    await tar.c({ file: archivePath, preservePaths: true }, [outsideFile]);

    await fs.mkdir(extractDir, { recursive: true });
    await expect(
      extractArchive({
        archivePath,
        destDir: extractDir,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/absolute|drive path|escapes destination/i);
  });
});
