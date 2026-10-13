import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { resolveOpenClawCompileCacheDirectory } from "../../node-compile-cache.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MiB = 1024 * 1024;

it("prewarms the release graph, respecting the disabled cache policy", async () => {
  const root = tempDirs.make("openclaw-cache-prewarm-");
  const launcher = path.join(root, "gateway-prewarm.mjs");
  const cache = path.join(root, "cache");
  await fs.copyFile(new URL("../../gateway-prewarm.mjs", import.meta.url), launcher);
  await fs.copyFile(
    new URL("../../node-compile-cache.mjs", import.meta.url),
    path.join(root, "node-compile-cache.mjs"),
  );
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module","version":"2026.10.1"}');
  await fs.writeFile(path.join(root, "dist", "build-info.json"), '{"buildId":"prewarm-release"}');
  await fs.writeFile(
    path.join(root, "dist", "gateway-prewarm.js"),
    `
    import { writeFileSync } from "node:fs";
    import { getCompileCacheDir } from "node:module";
    writeFileSync(new URL("../loaded", import.meta.url), getCompileCacheDir());
  `,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: cache };
  delete env.NODE_DISABLE_COMPILE_CACHE;
  const run = promisify(execFile);
  await run(process.execPath, [launcher], { env: { ...env, NODE_DISABLE_COMPILE_CACHE: "1" } });
  await expect(fs.stat(path.join(root, "loaded"))).rejects.toMatchObject({ code: "ENOENT" });
  // Start without an inherited native cache so the release owner chooses its namespace.
  await run(process.execPath, [launcher], {
    env: { ...env, NODE_COMPILE_CACHE: undefined, TMPDIR: root, TMP: root, TEMP: root },
  });
  const loaded = await fs.readFile(path.join(root, "loaded"), "utf8");
  expect(loaded).toContain(path.join(root, "node-compile-cache", "openclaw", "2026.10.1"));
  expect((await fs.readdir(loaded)).length).toBeGreaterThan(0);
});

async function maintainCompileCache(directory: string) {
  const worker = new Worker(new URL("../../node-compile-cache.mjs", import.meta.url), {
    workerData: { openclawCompileCacheDirectory: directory },
    execArgv: [],
    env: {},
  });
  const [code] = await once(worker, "exit");
  expect(code).toBe(0);
}

it.each([
  ["another-app", "1000-100"],
  ["openclaw", "unowned"],
])("preserves unqualified cache directories: %s/%s", async (owner, marker) => {
  const root = tempDirs.make("openclaw-cache-unowned-");
  const version = path.join(root, owner, "2026.9.6");
  const sibling = path.join(version, "2000-100");
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, "bytecode"), "keep");
  await maintainCompileCache(path.join(version, marker));
  expect(await fs.readdir(version)).toEqual(["2000-100"]);
  expect(await fs.readFile(path.join(sibling, "bytecode"), "utf8")).toBe("keep");
});

async function sparseFile(file: string, bytes: number) {
  const handle = await fs.open(file, "w");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

it("keeps inherited cache namespaces flat and retains recently prepared builds", async () => {
  const root = tempDirs.make("openclaw-cache-builds-");
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "package.json"), '{"version":"2026.9.6"}');
  const base = path.join(root, "cache");
  let inherited = path.join(base, "openclaw", "2026.9.6", "build-legacy");
  const directories = new Map<string, string>();
  for (let invocation = 0; invocation < 4; invocation++) {
    const buildId = `2026.9.7-release-c074824a27c${invocation % 2}-2026-09-29T23-33-45.013Z`;
    await fs.writeFile(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId }));
    const directory = expectDefined(
      resolveOpenClawCompileCacheDirectory({
        installRoot: root,
        env: { NODE_COMPILE_CACHE: inherited },
      }),
      "compile cache directory",
    );
    expect(path.dirname(directory)).toBe(path.join(base, "openclaw", "2026.9.6"));
    expect(path.basename(directory)).toMatch(/^[a-f0-9]{16}$/);
    if (directories.has(buildId)) {
      expect(directory).toBe(directories.get(buildId));
    } else {
      expect([...directories.values()]).not.toContain(directory);
      directories.set(buildId, directory);
    }
    await fs.mkdir(directory, { recursive: true });
    await sparseFile(path.join(directory, "bytecode"), 32 * MiB);
    await maintainCompileCache(directory);
    expect((await fs.readdir(path.dirname(directory))).toSorted()).toEqual(
      [...directories.values()].map((value) => path.basename(value)).toSorted(),
    );
    inherited = directory;
  }
});

it("prunes old bytecode and caps 600 MiB across releases without touching neighboring caches", async () => {
  const root = tempDirs.make("openclaw-cache-retention-");
  const cache = path.join(root, "openclaw");
  const directory = path.join(cache, "2026.9.6", "1000-100");
  const candidate = path.join(cache, "2026.9.7", "2000-100");
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(candidate, { recursive: true });
  await fs.writeFile(path.join(root, "another-app"), "keep");
  for (let index = 0; index < 6; index++) {
    await sparseFile(path.join(index < 3 ? directory : candidate, `bytecode-${index}`), 100 * MiB);
  }
  const old = path.join(directory, "expired");
  await fs.writeFile(old, "old");
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(old, expired, expired);
  await fs.utimes(cache, expired, expired);
  await maintainCompileCache(directory);
  const files = (await fs.readdir(cache, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  const bytes = (await Promise.all(files.map(async (file) => (await fs.stat(file)).size))).reduce(
    (total, size) => total + size,
    0,
  );
  expect(bytes).toBe(500 * MiB);
  expect(files).not.toContain(old);
  expect(await fs.readFile(path.join(root, "another-app"), "utf8")).toBe("keep");
});

it.each(["root", "version", "build"] as const)(
  "does not traverse a symlinked %s cache directory",
  async (boundary) => {
    const root = tempDirs.make("openclaw-cache-symlink-");
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep"), "keep");
    const cache = path.join(root, "cache", "openclaw");
    const version = path.join(cache, "2026.9.6");
    const directory = path.join(version, "1000-100");
    const target = boundary === "root" ? cache : boundary === "version" ? version : directory;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    await maintainCompileCache(directory);
    expect(await fs.readdir(outside)).toEqual(["keep"]);
  },
);
