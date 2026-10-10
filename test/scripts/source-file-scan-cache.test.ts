// Source File Scan Cache tests cover source file scan cache script behavior.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSourceFileContents } from "../../scripts/lib/source-file-scan-cache.mts";
import { createDeferred } from "../helpers/promise.js";

const tempDirs: string[] = [];
let pendingScan: ReturnType<typeof collectSourceFileContents> | undefined;

async function makeTempRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-source-scan-"));
  tempDirs.push(repoRoot);
  return repoRoot;
}

describe("source file scan cache", () => {
  afterEach(async () => {
    // Native test timeout releases held reads; join them before removing their files.
    await Promise.allSettled(pendingScan ? [pendingScan] : []);
    pendingScan = undefined;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("bounds concurrent source file reads while preserving sorted output", async ({ signal }) => {
    const repoRoot = await makeTempRepo();
    const srcRoot = path.join(repoRoot, "src");
    await mkdir(srcRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 9 }, async (_, index) => {
        const file = path.join(srcRoot, `file-${index}.ts`);
        await writeFile(file, `export const value${index} = ${index};\n`, "utf8");
      }),
    );

    let activeFiles = 0;
    let maxActiveFiles = 0;
    const reads = Array.from({ length: 9 }, (_, index) => ({
      name: `file-${index}.ts`,
      started: createDeferred(),
      release: createDeferred(),
      completed: createDeferred(),
    }));
    const releaseReads = () => {
      for (const read of reads) {
        read.release.resolve();
      }
    };
    const readFile = async (filePath: string) => {
      const read = reads.find((entry) => entry.name === path.basename(filePath))!;
      read.started.resolve();
      await read.release.promise;
      activeFiles -= 1;
      read.completed.resolve();
      return `content:${path.basename(filePath)}`;
    };

    signal.throwIfAborted();
    signal.addEventListener("abort", releaseReads, { once: true });
    const scan = (pendingScan = collectSourceFileContents({
      repoRoot,
      scanRoots: ["src"],
      scanExtensions: new Set([".ts"]),
      ignoredDirNames: new Set(),
      maxConcurrentReads: 3,
      statFile: (filePath) => {
        activeFiles += 1;
        maxActiveFiles = Math.max(maxActiveFiles, activeFiles);
        return stat(filePath);
      },
      readFile,
    }));

    try {
      for (let offset = 0; offset < reads.length; offset += 3) {
        const batch = reads.slice(offset, offset + 3);
        await Promise.all(batch.map((read) => read.started.promise));
        signal.throwIfAborted();
        expect(activeFiles).toBe(3);
        // Complete each admitted batch backwards so completion order cannot stand in for file order.
        for (const read of batch.toReversed()) {
          read.release.resolve();
          await read.completed.promise;
        }
      }
      const files = await scan;
      expect(maxActiveFiles).toBe(3);
      expect(files.map((file) => file.relativeFile)).toEqual(
        Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`),
      );
      expect(files.map((file) => file.content)).toEqual(
        Array.from({ length: 9 }, (_, index) => `content:file-${index}.ts`),
      );
    } finally {
      signal.removeEventListener("abort", releaseReads);
      releaseReads();
      await scan;
    }
  });

  it("rejects oversized source files before reading them", async () => {
    const repoRoot = await makeTempRepo();
    const srcRoot = path.join(repoRoot, "src");
    const oversizedPath = path.join(srcRoot, "oversized.ts");
    await mkdir(srcRoot, { recursive: true });
    await writeFile(oversizedPath, "x".repeat(32), "utf8");
    let readCalls = 0;

    await expect(
      collectSourceFileContents({
        repoRoot,
        scanRoots: ["src"],
        scanExtensions: new Set([".ts"]),
        ignoredDirNames: new Set(),
        maxFileBytes: 8,
        readFile: async () => {
          readCalls += 1;
          return "should not read";
        },
      }),
    ).rejects.toThrow("source scan file exceeds 8 byte limit: src/oversized.ts (32 bytes)");
    expect(readCalls).toBe(0);
  });

  it("rejects oversized source content returned after a bounded stat", async () => {
    const repoRoot = await makeTempRepo();
    const srcRoot = path.join(repoRoot, "src");
    await mkdir(srcRoot, { recursive: true });
    await writeFile(path.join(srcRoot, "generated.ts"), "small", "utf8");

    await expect(
      collectSourceFileContents({
        repoRoot,
        scanRoots: ["src"],
        scanExtensions: new Set([".ts"]),
        ignoredDirNames: new Set(),
        maxFileBytes: 8,
        readFile: async () => "x".repeat(16),
      }),
    ).rejects.toThrow("source scan file exceeds 8 byte limit: src/generated.ts (16 bytes)");
  });
});
