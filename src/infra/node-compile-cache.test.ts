import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { resolveOpenClawCompileCacheDirectory } from "../../node-compile-cache.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MiB = 1024 * 1024;
const run = promisify(execFile);
const helperUrl = new URL("../../node-compile-cache.mjs", import.meta.url);
const modulePath = fileURLToPath(helperUrl);
const evalModule = (script: string, env: NodeJS.ProcessEnv = {}) =>
  run(process.execPath, ["--input-type=module", "--eval", script], { env });

async function fileTree(files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-cache-");
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  return root;
}

async function cacheFixture() {
  const root = await fileTree();
  const cache = path.join(root, "openclaw");
  const directory = path.join(cache, "2026.9.6", "1000-100");
  await fs.mkdir(directory, { recursive: true });
  return { root, cache, directory };
}

it("remains synchronously importable from CommonJS bundles", async () => {
  const outfile = path.join(tempDirs.make("openclaw-cache-commonjs-"), "cache.cjs");
  await build({
    entryPoints: [modulePath],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  await run(process.execPath, ["-e", `require(${JSON.stringify(outfile)})`], { env: {} });
});

it("prewarms the release graph, respecting the disabled cache policy", async () => {
  const root = await fileTree({
    "package.json": '{"type":"module","version":"2026.10.1"}',
    "dist/build-info.json": '{"buildId":"prewarm-release"}',
    "dist/gateway-prewarm.js": `
    import { writeFileSync } from "node:fs";
    import { getCompileCacheDir } from "node:module";
    writeFileSync(new URL("../loaded", import.meta.url), getCompileCacheDir());
  `,
  });
  const launcher = path.join(root, "gateway-prewarm.mjs");
  for (const name of [
    "gateway-prewarm.mjs",
    "node-compile-cache.mjs",
    "cli-invocation.mjs",
    "cli-parent-lifetime.mjs",
    "gateway-shutdown-budget.mjs",
  ]) {
    await fs.copyFile(new URL(`../../${name}`, import.meta.url), path.join(root, name));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_COMPILE_CACHE: path.join(root, "cache") };
  delete env.NODE_DISABLE_COMPILE_CACHE;
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

it.each([false, true])("flushes native bytecode before exit (disabled: %s)", async (disabled) => {
  const root = await fileTree({
    "first.mjs": "export const value = 1;\n",
    "later.mjs": "export const value = 2;\n",
  });
  const cache = path.join(root, "cache");
  const script = `
      import assert from "node:assert/strict";
      import { readdirSync } from "node:fs";
      import { enableCompileCache, getCompileCacheDir } from "node:module";
      import { setImmediate as nextTurn } from "node:timers/promises";
      import { pathToFileURL } from "node:url";
      import { scheduleOpenClawCompileCacheFlush } from ${JSON.stringify(helperUrl.href)};
      enableCompileCache(${JSON.stringify(cache)});
      const directory = getCompileCacheDir();
      const entries = () => directory
        ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).length
        : 0;
      async function loadAndFlush(name, value) {
        assert.equal((await import(pathToFileURL(${JSON.stringify(root)} + "/" + name + ".mjs").href)).value, value);
        scheduleOpenClawCompileCacheFlush();
        await nextTurn();
        return entries();
      }
      const first = await loadAndFlush("first", 1);
      const later = await loadAndFlush("later", 2);
      // Capture disk contents before native process teardown could persist them.
      process.stdout.write(JSON.stringify({ enabled: directory !== undefined, first, later }));
    `;
  const { stdout } = await evalModule(script, {
    ...process.env,
    NODE_COMPILE_CACHE: undefined,
    NODE_COMPILE_CACHE_READONLY: undefined,
    NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
    NODE_OPTIONS: undefined,
  });
  const observed = JSON.parse(stdout);
  if (disabled) {
    expect(observed).toEqual({ enabled: false, first: 0, later: 0 });
    await expect(fs.stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    expect(observed.enabled).toBe(true);
    expect(observed.first).toBeGreaterThan(0);
    expect(observed.later).toBeGreaterThan(observed.first);
  }
});

async function maintainCompileCache(directory: string) {
  await run(process.execPath, [modulePath, "--maintain", directory], { env: {} });
}

it.each([
  ["another-app", "1000-100"],
  ["openclaw", "unowned"],
])("preserves unqualified cache directories: %s/%s", async (owner, marker) => {
  const root = await fileTree({ [`${owner}/2026.9.6/2000-100/bytecode`]: "keep" });
  const version = path.join(root, owner, "2026.9.6");
  const sibling = path.join(version, "2000-100");
  await maintainCompileCache(path.join(version, marker));
  expect(await fs.readdir(version)).toEqual(["2000-100"]);
  expect(await fs.readFile(path.join(sibling, "bytecode"), "utf8")).toBe("keep");
});

async function sparseFile(file: string, bytes: number) {
  await fs.writeFile(file, "");
  await fs.truncate(file, bytes);
}

it("keeps inherited cache namespaces flat and retains recently prepared builds", async () => {
  const root = await fileTree({ "package.json": '{"version":"2026.9.6"}' });
  await fs.mkdir(path.join(root, "dist"));
  const base = path.join(root, "cache");
  let inherited = path.join(base, "openclaw", "2026.9.6", "build-legacy");
  const directories = new Map<string, string>();
  for (let invocation = 0; invocation < 4; invocation++) {
    const buildId = `2026.9.7-release-c074824a27c${invocation % 2}-2026-09-29T23-33-45.013Z`;
    await fs.writeFile(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId }));
    const options = { installRoot: root, env: { NODE_COMPILE_CACHE: inherited } };
    const directory = expectDefined(
      resolveOpenClawCompileCacheDirectory(options),
      "cache directory",
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
  const { root, cache, directory } = await cacheFixture();
  const candidate = path.join(cache, "2026.9.7", "2000-100");
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

it("leaves failed pruning eligible for the next invocation", async () => {
  const { cache, directory } = await cacheFixture();
  const file = path.join(directory, "oversized");
  await sparseFile(file, 600 * MiB);
  await fs.utimes(cache, new Date(0), new Date(0));
  const { stdout } = await evalModule(`
    import fs from "node:fs/promises";
    fs.unlink = async () => {
      process.stdout.write(String((await fs.stat(${JSON.stringify(cache)})).mtimeMs));
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    process.argv = [process.execPath, ${JSON.stringify(modulePath)}, "--maintain", ${JSON.stringify(directory)}];
    await import(${JSON.stringify(helperUrl.href)});
  `);
  expect(stdout).toBe("0");
  expect((await fs.stat(cache)).mtimeMs).toBe(0);
  expect((await fs.stat(file)).size).toBe(600 * MiB);
  await maintainCompileCache(directory);
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.stat(cache)).mtimeMs).toBeGreaterThan(0);
});

it("makes bounded progress through tiny entries without claiming an incomplete pass", async () => {
  const { cache, directory } = await cacheFixture();
  await fs.utimes(cache, new Date(0), new Date(0));
  const { stdout } = await evalModule(`
    import fs from "node:fs/promises";
    import path from "node:path";
    const cache = ${JSON.stringify(cache)};
    const files = new Set(Array.from({ length: 20_000 }, (_, i) => "bytecode-" + i));
    const lstat = fs.lstat;
    fs.lstat = async target => files.has(path.basename(target))
      ? { size: 1, mtimeMs: Date.now() } : lstat(target);
    let visited = 0;
    fs.opendir = async () => ({ async *[Symbol.asyncIterator]() {
      for (const name of files) {
        visited++;
        yield { name, isDirectory: () => false, isFile: () => true };
      }
    }});
    fs.unlink = async target => { files.delete(path.basename(target)); };
    const rmdir = fs.rmdir;
    let finished;
    fs.rmdir = async target => { await rmdir(target); finished(); };
    process.argv = [process.execPath, ${JSON.stringify(modulePath)}, "--maintain", ${JSON.stringify(directory)}];
    const results = [];
    for (let pass = 0; pass < 2; pass++) {
      visited = 0;
      const completion = new Promise(resolve => { finished = resolve; });
      await import(${JSON.stringify(helperUrl.href)} + "?pass=" + pass);
      await completion;
      results.push({ visited, remaining: files.size, mtimeMs: (await fs.stat(cache)).mtimeMs });
    }
    process.stdout.write(JSON.stringify(results));
  `);
  const [partial, completed] = JSON.parse(stdout);
  expect(partial.visited).toBeLessThanOrEqual(16_385);
  expect(partial.remaining).toBeLessThan(20_000);
  expect(partial.remaining).toBeGreaterThan(4096);
  expect(partial.mtimeMs).toBe(0);
  expect(completed.remaining).toBeLessThanOrEqual(4096);
  expect(completed.mtimeMs).toBeGreaterThan(0);
});

it.each(["root", "version", "build"] as const)("rejects the %s cache symlink", async (boundary) => {
  const root = await fileTree({ "outside/keep": "keep" });
  const outside = path.join(root, "outside");
  const cache = path.join(root, "cache", "openclaw");
  const version = path.join(cache, "2026.9.6");
  const directory = path.join(version, "1000-100");
  const target = boundary === "root" ? cache : boundary === "version" ? version : directory;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
  await maintainCompileCache(directory);
  expect(await fs.readdir(outside)).toEqual(["keep"]);
});
