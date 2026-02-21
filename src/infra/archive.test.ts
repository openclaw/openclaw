import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArchiveSecurityError } from "./archive.js";
import { extractArchive, resolveArchiveKind, resolvePackedRootDir } from "./archive.js";

let fixtureRoot = "";
let fixtureCount = 0;

async function makeTempDir(prefix = "case") {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function withArchiveCase(
  ext: "zip" | "tar",
  run: (params: { workDir: string; archivePath: string; extractDir: string }) => Promise<void>,
) {
  const workDir = await makeTempDir(ext);
  const archivePath = path.join(workDir, `bundle.${ext}`);
  const extractDir = path.join(workDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });
  await run({ workDir, archivePath, extractDir });
}

async function writePackageArchive(params: {
  ext: "zip" | "tar";
  workDir: string;
  archivePath: string;
  fileName: string;
  content: string;
}) {
  if (params.ext === "zip") {
    const zip = new JSZip();
    zip.file(`package/${params.fileName}`, params.content);
    await fs.writeFile(params.archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    return;
  }

  const packageDir = path.join(params.workDir, "package");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, params.fileName), params.content);
  await tar.c({ cwd: params.workDir, file: params.archivePath }, ["package"]);
}

async function expectExtractedSizeBudgetExceeded(params: {
  archivePath: string;
  destDir: string;
  timeoutMs?: number;
  maxExtractedBytes: number;
}) {
  await expect(
    extractArchive({
      archivePath: params.archivePath,
      destDir: params.destDir,
      timeoutMs: params.timeoutMs ?? 5_000,
      limits: { maxExtractedBytes: params.maxExtractedBytes },
    }),
  ).rejects.toThrow("archive extracted size exceeds limit");
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-archive-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("archive utils", () => {
  it("detects archive kinds", () => {
    const cases = [
      { input: "/tmp/file.zip", expected: "zip" },
      { input: "/tmp/file.tgz", expected: "tar" },
      { input: "/tmp/file.tar.gz", expected: "tar" },
      { input: "/tmp/file.tar", expected: "tar" },
      { input: "/tmp/file.txt", expected: null },
    ] as const;
    for (const testCase of cases) {
      expect(resolveArchiveKind(testCase.input), testCase.input).toBe(testCase.expected);
    }
  });

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "extracts $ext archives",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writePackageArchive({
          ext,
          workDir,
          archivePath,
          fileName: "hello.txt",
          content: "hi",
        });
        await extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 });
        const rootDir = await resolvePackedRootDir(extractDir);
        const content = await fs.readFile(path.join(rootDir, "hello.txt"), "utf-8");
        expect(content).toBe("hi");
      });
    },
  );

  it("rejects zip path traversal (zip slip)", async () => {
    await withArchiveCase("zip", async ({ archivePath, extractDir }) => {
      const zip = new JSZip();
      zip.file("../b/evil.txt", "pwnd");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expect(
        extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
      ).rejects.toThrow(/(escapes destination|absolute)/i);
    });
  });

  it("rejects zip entries that traverse pre-existing destination symlinks", async () => {
    await withArchiveCase("zip", async ({ workDir, archivePath, extractDir }) => {
      const outsideDir = path.join(workDir, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(extractDir, "escape"));

      const zip = new JSZip();
      zip.file("escape/pwn.txt", "owned");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await expect(
        extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({
        code: "destination-symlink-traversal",
      } satisfies Partial<ArchiveSecurityError>);

      const outsideFile = path.join(outsideDir, "pwn.txt");
      const outsideExists = await fs
        .stat(outsideFile)
        .then(() => true)
        .catch(() => false);
      expect(outsideExists).toBe(false);
    });
  });

  it("rejects tar path traversal (zip slip)", async () => {
    await withArchiveCase("tar", async ({ workDir, archivePath, extractDir }) => {
      const insideDir = path.join(workDir, "inside");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(workDir, "outside.txt"), "pwnd");

      await tar.c({ cwd: insideDir, file: archivePath }, ["../outside.txt"]);

      await expect(
        extractArchive({ archivePath, destDir: extractDir, timeoutMs: 5_000 }),
      ).rejects.toThrow(/escapes destination/i);
    });
  });

  it.each([{ ext: "zip" as const }, { ext: "tar" as const }])(
    "rejects $ext archives that exceed extracted size budget",
    async ({ ext }) => {
      await withArchiveCase(ext, async ({ workDir, archivePath, extractDir }) => {
        await writePackageArchive({
          ext,
          workDir,
          archivePath,
          fileName: "big.txt",
          content: "x".repeat(64),
        });

        await expectExtractedSizeBudgetExceeded({
          archivePath,
          destDir: extractDir,
          maxExtractedBytes: 32,
        });
      });
    },
  );

  it("rejects archives that exceed archive size budget", async () => {
    await withArchiveCase("zip", async ({ archivePath, extractDir }) => {
      const zip = new JSZip();
      zip.file("package/file.txt", "ok");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      const stat = await fs.stat(archivePath);

      await expect(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: 5_000,
          limits: { maxArchiveBytes: Math.max(1, stat.size - 1) },
        }),
      ).rejects.toThrow("archive size exceeds limit");
    });
  });

  it("fails resolvePackedRootDir when extract dir has multiple root dirs", async () => {
    const workDir = await makeTempDir("packed-root");
    const extractDir = path.join(workDir, "extract");
    await fs.mkdir(path.join(extractDir, "a"), { recursive: true });
    await fs.mkdir(path.join(extractDir, "b"), { recursive: true });
    await expect(resolvePackedRootDir(extractDir)).rejects.toThrow(/unexpected archive layout/i);
  });

  it("rejects tar entries with absolute extraction paths", async () => {
    await withArchiveCase("tar", async ({ workDir, archivePath, extractDir }) => {
      const inputDir = path.join(workDir, "input");
      const outsideFile = path.join(inputDir, "outside.txt");
      await fs.mkdir(inputDir, { recursive: true });
      await fs.writeFile(outsideFile, "owned");
      await tar.c({ file: archivePath, preservePaths: true }, [outsideFile]);

      await expect(
        extractArchive({
          archivePath,
          destDir: extractDir,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/absolute|drive path|escapes destination/i);
    });
  });
});
