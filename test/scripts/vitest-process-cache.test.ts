import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveNativeFixtureShortPath } from "./native-boundary-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

it.each([
  ["hermetic", undefined],
  ["live-aware", undefined],
  ["tooling", undefined],
  ["hermetic", "caller-cache"],
  ["hermetic", ""],
  ["hermetic", "0"],
] as const)(
  "reuses owned source compiler caches (%s, Bun cache %s)",
  async (homeMode, bunCache) => {
    const root = fs.realpathSync(tempDirs.make("oc-vt-source-cache-"));
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
const output = run();
const first = entries();
const again = run();
console.log(JSON.stringify({ namespace, output, again, disabled: process.env.TSX_DISABLE_CACHE, cached: first.length > 0, reused: JSON.stringify(entries()) === JSON.stringify(first), bunCache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH }));
`;
    const env = {
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
      args: ["--import", tsxPreload, "--input-type=module", "-e", script],
      homeMode,
      options: { env, stdio: ["ignore", "pipe", "pipe"] },
    });
    expect(result, stderr).toMatchObject({
      code: 0,
      groupJoined: process.platform !== "win32",
    });
    const observed = JSON.parse(stdout);
    expect([observed.output, observed.again, observed.reused]).toEqual(["42\n", "42\n", true]);
    expect(observed.disabled).toBe(homeMode === "tooling" ? "1" : undefined);
    expect(observed.cached, JSON.stringify(observed)).toBe(homeMode !== "tooling");
    expect(observed.bunCache).toBe(
      bunCache ??
        (homeMode === "tooling"
          ? undefined
          : path.resolve(import.meta.dirname, "../../.cache/bun-transpiler")),
    );
    expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(bunCache);
    expect(path.dirname(observed.namespace)).toBe(root);
    expect(env.TSX_DISABLE_CACHE).toBe("1");
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
