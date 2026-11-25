import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { buildBenchmarkCommandEnv } from "../../scripts/lib/vitest-pair-benchmark.mts";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveNativeFixtureShortPath } from "./native-boundary-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const shortTempRoot = process.platform === "win32" ? undefined : fs.realpathSync.native("/tmp");
const testNodeExecPath = resolveTestNodeExecPath();
const tsxPreload = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

async function run(spec: Parameters<typeof spawnOwnedVitestProcess>[0]) {
  const { child, completion } = spawnOwnedVitestProcess(spec);
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => {
      output[stream] += chunk.toString();
    });
  }
  return { result: await completion, ...output };
}

it.skipIf(process.platform === "win32").each([
  [45, "x", false],
  [46, "x", true],
  [45, "é", true],
  [100, "x", true],
] as const)(
  "leaves socket headroom for a %i-character temp root (%s)",
  async (length, fill, relocated) => {
    const base = fs.realpathSync(tempDirs.make("vt-", "/tmp"));
    const root = path.join(base, fill.repeat(length - base.length - 1));
    fs.mkdirSync(root);
    const parent = createVitestResourceOwner(root);
    const result = run({
      command: testNodeExecPath,
      args: [
        "--input-type=module",
        "-e",
        `
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const root = os.tmpdir();
const directory = fs.mkdtempSync(path.join(root, "org.chromium.Chromium."));
const socket = path.join(directory, "SingletonSocket");
if (Buffer.byteLength(socket) >= 104) throw new Error("Socket path too long: " + socket);
const server = net.createServer();
server.listen(socket, () => {
  console.log(JSON.stringify([root, process.env.TMP, process.env.TEMP]));
  server.close();
});
`,
      ],
      homeMode: "tooling",
      options: {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    expect(() => parent.assertReleased()).toThrow("Unreleased Vitest resource claim");
    const { result: completed, stdout, stderr } = await result;
    expect(completed.code, stderr).toBe(0);
    const [namespace, tmp, temp] = JSON.parse(stdout);
    expect([tmp, temp]).toEqual([namespace, namespace]);
    expect(path.dirname(namespace) === root).toBe(!relocated);
    expect(() => parent.assertReleased()).not.toThrow();
    expect(fs.existsSync(namespace)).toBe(false);
  },
);

it.each([
  ["hermetic", undefined, undefined],
  ["live-aware", undefined, undefined],
  ["tooling", undefined, undefined],
  ["hermetic", "caller-cache", undefined],
  ["hermetic", "", undefined],
  ["hermetic", undefined, "disabled"],
  ["hermetic", undefined, "seeded"],
] as const)(
  "reuses owned source compiler caches (%s, Bun cache %s, benchmark %s)",
  async (homeMode, bunCache, treatment) => {
    const root = fs.realpathSync(tempDirs.make("oc-vt-source-cache-", shortTempRoot));
    const sourcePath = path.join(root, "source.mts");
    fs.writeFileSync(sourcePath, "export enum Value { Answer = 42 }\n");
    const script = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const namespace = os.tmpdir();
const cache = path.join(namespace, "tsx-" + (process.geteuid?.() ?? os.userInfo().username));
const entries = () => fs.existsSync(cache) ? fs.readdirSync(cache).map(name => [name, fs.statSync(path.join(cache, name)).mtimeMs]) : [];
const run = () => {
  const result = spawnSync(process.execPath, ["--import", ${JSON.stringify(tsxPreload)}, "--input-type=module", "-e", ${JSON.stringify(`import { Value } from ${JSON.stringify(pathToFileURL(sourcePath).href)}; console.log(Value.Answer);`)}], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const initiallyCached = entries().length > 0;
const output = run();
const first = entries();
const again = run();
console.log(JSON.stringify({ namespace, output, again, initiallyCached, disabled: process.env.TSX_DISABLE_CACHE, cached: first.length > 0, reused: JSON.stringify(entries()) === JSON.stringify(first), bunCache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
  executable: process.execPath, nodeCache: process.env.NODE_COMPILE_CACHE, nodeDisabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
  runtime: process.env.OPENCLAW_VITEST_RUNTIME, fsCache: process.env.OPENCLAW_VITEST_FS_MODULE_CACHE, workerCache: process.env.OPENCLAW_VITEST_WORKER_CACHE, workers: process.env.OPENCLAW_VITEST_MAX_WORKERS }));
`;
    const nodeCache = path.join(root, "node-compile");
    const env = treatment
      ? buildBenchmarkCommandEnv(
          path.join(root, "home"),
          path.join(root, "state"),
          {
            executable: testNodeExecPath,
            resolvedExecutable: testNodeExecPath,
            version: "fixture",
          },
          { PATH: process.env.PATH, TSX_DISABLE_CACHE: "poison" },
          { kind: treatment, nodeCache },
        )
      : {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          TSX_DISABLE_CACHE: "1",
          NODE_DISABLE_COMPILE_CACHE: "1",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: bunCache,
          ESBUILD_WORKER_THREADS: "0",
        };
    const { result, stdout, stderr } = await run({
      command: testNodeExecPath,
      args: ["--input-type=module", "-e", script],
      homeMode,
      options: { env, stdio: ["ignore", "pipe", "pipe"] },
    });
    expect(result, stderr).toMatchObject({
      code: 0,
      groupJoined: process.platform !== "win32",
    });
    const observed = JSON.parse(stdout);
    expect(observed.initiallyCached).toBe(false);
    expect([observed.output, observed.again, observed.reused]).toEqual(["42\n", "42\n", true]);
    expect(observed.disabled).toBe(homeMode === "tooling" ? "1" : undefined);
    expect(observed.cached, JSON.stringify(observed)).toBe(homeMode !== "tooling");
    expect(observed.bunCache).toBe(
      bunCache ??
        (homeMode === "tooling"
          ? undefined
          : path.resolve(import.meta.dirname, "../../.cache/bun-transpiler")),
    );
    if (treatment) {
      expect(observed).toMatchObject({
        nodeCache,
        nodeDisabled: treatment === "disabled" ? "1" : null,
        runtime: "node",
        fsCache: "0",
        workerCache: "0",
        workers: "1",
      });
      expect(fs.realpathSync(observed.executable)).toBe(fs.realpathSync(testNodeExecPath));
      expect(observed.namespace).not.toBe(env.TMPDIR);
      // Long socket paths can relocate the owned namespace to the platform temp root.
      expect([fs.realpathSync(env.TMPDIR!), shortTempRoot]).toContain(
        path.dirname(observed.namespace),
      );
    } else {
      expect(path.dirname(observed.namespace)).toBe(root);
    }
    expect(fs.existsSync(observed.namespace)).toBe(process.platform === "win32");
  },
);

it.skipIf(process.platform !== "win32")(
  "publishes long temp paths to owned Windows children",
  async ({ skip }) => {
    const root = tempDirs.make("oc-vt-short-name-");
    const shortRoot = resolveNativeFixtureShortPath(root);
    if (!shortRoot) {
      skip();
      return;
    }
    const { result, stdout, stderr } = await run({
      command: testNodeExecPath,
      args: [
        "-e",
        "console.log(JSON.stringify([process.env.TMPDIR, process.env.TMP, process.env.TEMP]))",
      ],
      homeMode: "tooling",
      options: {
        env: { ...process.env, TMPDIR: shortRoot, TMP: shortRoot, TEMP: shortRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    expect(result.code, stderr).toBe(0);
    const [tmpdir, tmp, temp] = JSON.parse(stdout);
    expect(tmpdir).toBe(fs.realpathSync.native(tmpdir));
    expect(path.dirname(tmpdir)).toBe(fs.realpathSync.native(root));
    expect([tmp, temp]).toEqual([tmpdir, tmpdir]);
  },
);

it("isolates fixture module detection from an enclosing ESM package", async () => {
  const root = tempDirs.make("oc-vt-package-scope-", shortTempRoot);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const script = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const fixtures = path.join(os.tmpdir(), "fixtures");
fs.mkdirSync(fixtures);
fs.writeFileSync(path.join(fixtures, "commonjs"), 'console.log(require("node:path").basename("/cjs"));');
fs.writeFileSync(path.join(fixtures, "value.js"), 'export const value = "esm";');
fs.writeFileSync(path.join(fixtures, "module.js"), 'import { value } from "./value.js"; console.log(value);');
for (const name of ["commonjs", "module.js"]) {
  const result = spawnSync(process.execPath, [path.join(fixtures, name)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  process.stdout.write(result.stdout);
}
`;
  const { child, completion } = spawnOwnedVitestProcess({
    command: testNodeExecPath,
    args: ["--input-type=module", "-e", script],
    homeMode: "tooling",
    options: {
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  let errorOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  expect((await completion).code, errorOutput).toBe(0);
  expect(output).toBe("cjs\nesm\n");
});
