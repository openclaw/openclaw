import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectSourceFileContents } from "../../scripts/lib/source-file-scan-cache.mts";
import { createDeferred } from "../helpers/promise.js";

const tempDirs: string[] = [];
let pendingScan: ReturnType<typeof collectSourceFileContents> | undefined;

async function sourceFixture(files: Record<string, string>) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-source-scan-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "src"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(repoRoot, "src", name), content, "utf8");
  }
  return (overrides: Partial<Parameters<typeof collectSourceFileContents>[0]>) =>
    collectSourceFileContents({
      repoRoot,
      scanRoots: ["src"],
      scanExtensions: new Set([".ts"]),
      ignoredDirNames: new Set(),
      ...overrides,
    });
}

afterEach(async () => {
  // Native test timeout releases held reads; join them before removing their files.
  await Promise.allSettled(pendingScan ? [pendingScan] : []);
  pendingScan = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("bounds concurrent source file reads while preserving sorted output", async ({ signal }) => {
  const names = Array.from({ length: 9 }, (_, index) => `file-${index}.ts`);
  const fixture = await sourceFixture(Object.fromEntries(names.map((name) => [name, "source"])));

  let activeFiles = 0;
  let maxActiveFiles = 0;
  const reads = names.map((name) => ({
    name,
    started: createDeferred(),
    release: createDeferred(),
    completed: createDeferred(),
  }));
  const releaseReads = () => reads.forEach((read) => read.release.resolve());

  signal.throwIfAborted();
  signal.addEventListener("abort", releaseReads, { once: true });
  const scan = (pendingScan = fixture({
    maxConcurrentReads: 3,
    statFile: (filePath) => {
      activeFiles += 1;
      maxActiveFiles = Math.max(maxActiveFiles, activeFiles);
      return stat(filePath);
    },
    readFile: async (filePath) => {
      const read = reads.find((entry) => entry.name === path.basename(filePath))!;
      read.started.resolve();
      await read.release.promise;
      activeFiles -= 1;
      read.completed.resolve();
      return `content:${read.name}`;
    },
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
    expect(files.map((file) => file.relativeFile)).toEqual(names.map((name) => `src/${name}`));
    expect(files.map((file) => file.content)).toEqual(names.map((name) => `content:${name}`));
  } finally {
    signal.removeEventListener("abort", releaseReads);
    releaseReads();
    await scan;
  }
});

it.each<[string, string, number, number]>([
  ["before reading", "x".repeat(32), 32, 0],
  ["after reading", "small", 16, 1],
])("rejects oversized sources %s", async (_phase, content, bytes, calls) => {
  const scan = await sourceFixture({ "oversized.ts": content });
  let readCalls = 0;
  await expect(
    scan({
      maxFileBytes: 8,
      readFile: async () => {
        readCalls += 1;
        return "x".repeat(16);
      },
    }),
  ).rejects.toThrow(`source scan file exceeds 8 byte limit: src/oversized.ts (${bytes} bytes)`);
  expect(readCalls).toBe(calls);
});
