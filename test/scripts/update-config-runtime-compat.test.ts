import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import * as postbuild from "../../scripts/runtime-postbuild.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const moduleUrl = (file: string, query = "") => JSON.stringify(pathToFileURL(file).href + query);
const diagnosticsScript = `const diagnostics = { warnings: [], errors: [] };
for (const [method, key] of [["warn", "warnings"], ["error", "errors"]]) {
  console[method] = (...args) => diagnostics[key].push(args.join(" "));
}`;
const warning = (reason: string) =>
  `[update:warning:candidate-config-read-failed] Candidate config read failed: ${reason}. The existing service definition was left unchanged. After the update finishes, run openclaw gateway install --force with the same --profile or --dev option as this update to refresh it.`;
const simpleRuntime = (before = "", value = "{ valid: true }", factory = false) => `${before}
const snapshot = () => (${value});
export function createConfigIO() { return { loadConfig: snapshot${factory ? ", readConfigFileSnapshot: async () => snapshot()" : ""} }; }
export async function readConfigFileSnapshot() { return snapshot(); }
export function readCurrentConfigForPolicyCheck() { return snapshot(); }`;
async function candidateFixture(code: string, files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-update-config-");
  const dist = path.join(root, "dist");
  for (const [name, contents] of Object.entries({
    "package.json": '{"type":"module"}',
    "dist/io.runtime-Candidate.mjs": code,
    ...files,
  })) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  postbuild.rewriteRootRuntimeImportsToStableAliases({ rootDir: root });
  postbuild.writeStableRootRuntimeAliases({ rootDir: root });
  return { root, dist, alias: path.join(dist, "io.runtime.js") };
}

function runScript(
  script: string,
  warnings: string[] = [],
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
  timeout = 30_000,
) {
  const assertion = `assert.deepEqual(diagnostics, ${JSON.stringify({ warnings, errors: [] })});`;
  const program = `import assert from "node:assert/strict";\n${diagnosticsScript}\n${script}\n${assertion}`;
  const result = spawnSync(node, ["--input-type=module", "--eval", program], {
    cwd,
    encoding: "utf8",
    timeout,
    env: { ...process.env, NODE_OPTIONS: "", OPENCLAW_UPDATE_IN_PROGRESS: "1", ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
}

it("imports the reader once without spawning when a loader strips URL queries", async () => {
  const { root, dist, alias } = await candidateFixture(
    simpleRuntime("globalThis.readerImports = (globalThis.readerImports ?? 0) + 1;"),
  );
  const parentAlias = path.join(dist, "parent.runtime.js");
  await fs.copyFile(alias, parentAlias);
  const script = `import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
let spawns = 0;
childProcess.spawn = childProcess.spawnSync = () => {
  spawns++;
  throw new Error("Unexpected recursive config reader");
};
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith("file:")) {
    const url = new URL(result.url);
    url.search = "";
    result.url = url.href;
  }
  return result;
} });
const parent = await import(${moduleUrl(parentAlias)});
process.env.OPENCLAW_CONFIG_READ_CHILD = "1";
const reader = await import(${moduleUrl(alias, "?openclaw-config-read=1")});
assert.deepEqual(await reader.readConfigFileSnapshot(), { valid: true });
assert.deepEqual(reader.createConfigIO().loadConfig(), { valid: true });
assert.deepEqual(reader.readCurrentConfigForPolicyCheck(), { valid: true });
assert.equal(globalThis.readerImports, 1);
await assert.rejects(parent.readConfigFileSnapshot(), { code: "candidate-config-read-recursion" });
assert.throws(() => parent.createConfigIO({ env: {} }).loadConfig(), { code: "candidate-config-read-recursion" });
assert.equal(spawns, 0);`;
  runScript(
    script,
    Array(2).fill(
      "[update:warning:candidate-config-read-recursion] A config reader child cannot launch another reader.",
    ),
    {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_READ_CHILD: "",
    },
    undefined,
    10_000,
  );
});

it("returns candidate reads larger than the reader's stdout buffer intact", async () => {
  // About 1 MB: well past macOS pipe and Linux socketpair buffers.
  const { alias } = await candidateFixture(
    simpleRuntime("", '{ valid: true, text: "🦞 café ".repeat(100_000) }', true),
  );
  const script = `const expected = { valid: true, text: "🦞 café ".repeat(100_000) };
const reader = await import(${moduleUrl(alias)});
assert.deepEqual(await reader.readConfigFileSnapshot(), expected);
assert.deepEqual(await reader.createConfigIO().readConfigFileSnapshot(), expected);
assert.deepEqual(reader.readCurrentConfigForPolicyCheck(), expected);
assert.deepEqual(reader.createConfigIO().loadConfig(), expected);`;
  runScript(script);
});

it("reports a reader exit without a result while withholding the reader's stderr", async () => {
  const { alias } = await candidateFixture(
    simpleRuntime(
      `if (process.env.OPENCLAW_CONFIG_READ_CHILD === "1") {
  process.stderr.write("synthetic-config-secret\\n");
  process.exit(7);
}`,
    ),
  );
  const script = `const reader = await import(${moduleUrl(alias)});
await assert.rejects(reader.readConfigFileSnapshot(), { code: "candidate-config-read-failed" });
assert.throws(() => reader.readCurrentConfigForPolicyCheck(), { code: "candidate-config-read-failed" });`;
  runScript(
    script,
    Array(2).fill(warning("reader process exited with code 7 without a result")),
    {},
    undefined,
    10_000,
  );
});

it("reads candidate config after a package swap without reusing the driver's dependencies", async () => {
  const { root, dist, alias } = await candidateFixture(
    `import { probePathCaseInsensitiveSync } from "handoff-dependency/advanced";
if (process.env.OPENCLAW_CONFIG_READ_CHILD === "1") {
  console.log("reader stdout diagnostic");
  process.stdout.write("reader stdout chunk\\n");
}
export const createConfigIO = (options = {}) => ({
    readBestEffortConfig: async () => ({
      generation: probePathCaseInsensitiveSync(),
      pid: process.pid,
      cwd: process.cwd(),
      selection: options.env?.OPENCLAW_CONFIG_PATH,
      text: "🦞 café",
    }),
    readConfigFileSnapshot: async () => ({ valid: true, generation: probePathCaseInsensitiveSync() }),
    loadConfig: () => ({ generation: probePathCaseInsensitiveSync() }),
});
export async function readConfigFileSnapshot() { return createConfigIO().readConfigFileSnapshot(); }
export function readCurrentConfigForPolicyCheck() { return createConfigIO().loadConfig(); }
export function normalRuntimeApi() { return process.pid; }
`,
    {
      "node_modules/handoff-dependency/package.json":
        '{"type":"module","exports":{"./advanced":"./advanced.js"}}',
      "node_modules/handoff-dependency/advanced.js": "export const generation = 1;\n",
      "dist/current-consumer.mjs": 'export { createConfigIO } from "./io.runtime-Candidate.mjs";\n',
      "dist/previous-runtime.mjs": `import { generation } from "handoff-dependency/advanced";
     export function createConfigIO() { return { readBestEffortConfig: async () => ({ generation }) }; }
     export async function readConfigFileSnapshot() { return { generation }; }`,
    },
  );
  const dependencyFile = path.join(root, "node_modules", "handoff-dependency", "advanced.js");
  const currentEntry = path.join(dist, "current-consumer.mjs");

  const script = `import fs from "node:fs/promises";
const dependency = ${moduleUrl(dependencyFile)};
const aliasPath = ${JSON.stringify(alias)};
const candidatePath = ${JSON.stringify(path.join(dist, "io.runtime-Candidate.mjs"))};
const aliasBytes = await fs.readFile(aliasPath);
const candidateBytes = await fs.readFile(candidatePath);
const driverDependency = await import(dependency);
assert.equal(driverDependency.generation, 1);
await fs.writeFile(new URL(dependency), "export const generation = 2; export function probePathCaseInsensitiveSync() { return generation; }\\n");
process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
const runtime = await import(${moduleUrl(alias)});
const io = runtime.createConfigIO({ env: { ...process.env, OPENCLAW_CONFIG_PATH: "synthetic-config-selection" } });
const { pid, ...config } = await io.readBestEffortConfig();
assert.notEqual(pid, process.pid);
assert.deepEqual(config, { generation: 2, cwd: ${JSON.stringify(root)}, selection: "synthetic-config-selection", text: "🦞 café" });
assert.deepEqual([
  (await runtime.readConfigFileSnapshot()).generation, (await io.readConfigFileSnapshot()).valid,
  io.loadConfig().generation, runtime.readCurrentConfigForPolicyCheck().generation,
], [2, true, 2, 2]);
assert.equal((await import(dependency)).generation, 1);
await fs.unlink(new URL(dependency));
await assert.rejects(io.readBestEffortConfig(), { code: "candidate-config-read-failed" });
await fs.writeFile(new URL(dependency), "export const generation = 1;\\n");
await fs.writeFile(aliasPath, 'export * from "./previous-runtime.mjs";');
await fs.unlink(candidatePath);
assert.equal((await io.readBestEffortConfig()).generation, 1);
assert.equal((await runtime.readConfigFileSnapshot()).generation, 1);
await fs.writeFile(candidatePath, candidateBytes);
await fs.writeFile(aliasPath, aliasBytes);
await fs.writeFile(new URL(dependency), "export function probePathCaseInsensitiveSync() { return 2; }\\n");
assert.equal((await io.readBestEffortConfig()).generation, 2);`;
  runScript(
    script,
    [
      warning(
        `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${dependencyFile}' imported from ${path.join(dist, "io.runtime-Candidate.mjs")}`,
      ),
    ],
    {
      OPENCLAW_UPDATE_IN_PROGRESS: process.env.OPENCLAW_UPDATE_IN_PROGRESS,
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    path.dirname(root),
  );

  for (const { marker, entry } of [
    { marker: "0", entry: alias },
    { marker: "1", entry: currentEntry },
  ]) {
    runScript(
      `const runtime = await import(${moduleUrl(entry)});
       const result = await runtime.createConfigIO().readBestEffortConfig();
       assert.equal(result.generation, 2);
       if (${JSON.stringify(marker)} === "0") assert.equal(runtime.normalRuntimeApi(), process.pid);
       assert.equal(result.pid === process.pid, ${JSON.stringify(marker)} === "0");`,
      [],
      {
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_UPDATE_IN_PROGRESS: marker,
      },
    );
  }
});
