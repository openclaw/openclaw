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

it("bounds reads, refills the pool, and returns sorted content despite a held first read", async ({
  signal,
}) => {
  const names = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const fixture = await sourceFixture(Object.fromEntries(names.map((name) => [name, "source"])));
  const held = createDeferred();
  const refilled = createDeferred();
  let active = 0;
  let maximum = 0;
  const release = () => held.resolve();
  signal.throwIfAborted();
  signal.addEventListener("abort", release, { once: true });
  const scan = (pendingScan = fixture({
    maxConcurrentReads: 2,
    statFile: (file) => {
      maximum = Math.max(maximum, ++active);
      return stat(file);
    },
    readFile: async (file) => {
      const name = path.basename(file);
      if (name === names[0]) {
        await held.promise;
      }
      active--;
      if (name === names.at(-1)) {
        refilled.resolve();
      }
      return `content:${name}`;
    },
  }));
  try {
    await refilled.promise;
    signal.throwIfAborted();
    expect(maximum).toBe(2);
    expect(active).toBe(1);
    release();
    const files = await scan;
    expect(files.map((file) => file.relativeFile)).toEqual(names.map((name) => `src/${name}`));
    expect(files.map((file) => file.content)).toEqual(names.map((name) => `content:${name}`));
  } finally {
    signal.removeEventListener("abort", release);
    release();
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
