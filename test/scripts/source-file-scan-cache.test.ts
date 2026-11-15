import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  collectSourceFileContents,
  mapSourceFileContents,
} from "../../scripts/lib/source-file-scan-cache.mts";
import { createDeferred } from "../helpers/promise.js";

const tempDirs: string[] = [];
let pendingScan: ReturnType<typeof collectSourceFileContents> | undefined;

async function sourceFixture(files: Record<string, string | Uint8Array>) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-source-scan-"));
  tempDirs.push(repoRoot);
  await mkdir(path.join(repoRoot, "src"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(repoRoot, "src", name), content, "utf8");
  }
  return {
    repoRoot,
    scanRoots: ["src"],
    scanExtensions: new Set([".ts"]),
    ignoredDirNames: new Set<string>(),
  };
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
  const scan = (pendingScan = collectSourceFileContents({
    ...fixture,
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
    collectSourceFileContents({
      ...scan,
      maxFileBytes: 8,
      readFile: async () => {
        readCalls += 1;
        return "x".repeat(16);
      },
    }),
  ).rejects.toThrow(`source scan file exceeds 8 byte limit: src/oversized.ts (${bytes} bytes)`);
  expect(readCalls).toBe(calls);
});

it("maps decoded contents to compact results in source-path order", async () => {
  const fixture = await sourceFixture({
    "b.ts": new Uint8Array([0xff]),
    "a.ts": "\uFEFFhello\r\n猫",
  });
  const results = await mapSourceFileContents(fixture, ({ relativeFile, content }) => [
    relativeFile,
    Buffer.byteLength(content, "utf8"),
  ]);
  expect(results).toEqual([
    ["src/a.ts", 13],
    ["src/b.ts", 3],
  ]);
});

it("propagates a read failure before mapping its source", async () => {
  const fixture = await sourceFixture({ "denied.ts": "source" });
  const error = Object.assign(new Error("read denied"), { code: "EACCES" });
  let mapped = 0;
  await expect(
    mapSourceFileContents(
      {
        ...fixture,
        readFile: async () => {
          throw error;
        },
      },
      () => ++mapped,
    ),
  ).rejects.toBe(error);
  expect(mapped).toBe(0);
});

it.each(["delete", "grow", "replace"] as const)(
  "preserves read semantics when a source changes after stat: %s",
  async (mutation) => {
    for (const mode of ["collect", "map"] as const) {
      const fixture = await sourceFixture({ "mutable.ts": "before" });
      let mapped = 0;
      const params = {
        ...fixture,
        maxFileBytes: 8,
        statFile: async (file: string) => {
          const before = await stat(file);
          if (mutation === "delete") {
            await rm(file);
          } else if (mutation === "grow") {
            await writeFile(file, "x".repeat(16));
          } else {
            const replacement = `${file}.replacement`;
            await writeFile(replacement, "after");
            await rename(replacement, file);
          }
          return before;
        },
      };
      const scan =
        mode === "collect"
          ? collectSourceFileContents(params)
          : mapSourceFileContents(params, ({ relativeFile, content }) => {
              mapped += 1;
              return { relativeFile, content };
            });
      if (mutation === "delete") {
        await expect(scan).rejects.toMatchObject({ code: "ENOENT" });
      } else if (mutation === "grow") {
        await expect(scan).rejects.toThrow(
          "source scan file exceeds 8 byte limit: src/mutable.ts (16 bytes)",
        );
      } else {
        await expect(scan).resolves.toEqual([
          {
            ...(mode === "collect"
              ? { filePath: path.join(fixture.repoRoot, "src/mutable.ts") }
              : {}),
            relativeFile: "src/mutable.ts",
            content: "after",
          },
        ]);
      }
      expect(mapped).toBe(mode === "map" && mutation === "replace" ? 1 : 0);
    }
  },
);
