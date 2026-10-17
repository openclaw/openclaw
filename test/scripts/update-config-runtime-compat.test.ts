import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  rewriteRootRuntimeImportsToStableAliases,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const moduleUrl = (file: string, query = "") => JSON.stringify(pathToFileURL(file).href + query);
const diagnosticsScript = `const diagnostics = { warnings: [], errors: [] };
for (const [method, key] of [["warn", "warnings"], ["error", "errors"]]) {
  console[method] = (...args) => diagnostics[key].push(args.join(" "));
}`;
const simpleRuntime = (snapshot: string, prelude = "", snapshotMethod = false) => `${prelude}
const snapshot = () => (${snapshot});
export function createConfigIO() { return { loadConfig: snapshot${snapshotMethod ? ", readConfigFileSnapshot: async () => snapshot()" : ""} }; }
export async function readConfigFileSnapshot() { return snapshot(); }
export function readCurrentConfigForPolicyCheck() { return snapshot(); }
`;
async function candidateFixture(
  prefix: string,
  source: string,
  files: Record<string, string> = {},
) {
  const root = tempDirs.make(`openclaw-update-config-${prefix}-`);
  const dist = path.join(root, "dist");
  for (const [name, contents] of Object.entries({
    "package.json": '{"type":"module"}',
    "dist/io.runtime-Candidate.mjs": source,
    ...files,
  })) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  return { root, dist };
}

function runScript(
  script: string,
  options: { root?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const program = `import assert from "node:assert/strict";\n${script}`;
  const result = spawnSync(node, ["--input-type=module", "--eval", program], {
    cwd: options.root,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    env: { ...process.env, NODE_OPTIONS: "", OPENCLAW_UPDATE_IN_PROGRESS: "1", ...options.env },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

it("imports the reader once without spawning when a loader strips URL queries", async () => {
  const { root, dist } = await candidateFixture(
    "child",
    simpleRuntime(
      "{ valid: true }",
      "globalThis.readerImports = (globalThis.readerImports ?? 0) + 1;",
    ),
  );
  writeStableRootRuntimeAliases({ rootDir: root });
  const alias = path.join(dist, "io.runtime.js");
  const parentAlias = path.join(dist, "parent.runtime.js");
  await fs.copyFile(alias, parentAlias);
  const script = `
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
let spawns = 0;
${diagnosticsScript}
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
assert.equal(spawns, 0);
console.log(JSON.stringify({ readerImports: globalThis.readerImports, spawns, diagnostics }));
`;
  const result = runScript(script, {
    timeout: 10_000,
    env: {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_CONFIG_READ_CHILD: "",
    },
  });
  expect(JSON.parse(result)).toEqual({
    readerImports: 1,
    spawns: 0,
    diagnostics: {
      warnings: Array(2).fill(
        "[update:warning:candidate-config-read-recursion] A config reader child cannot launch another reader.",
      ),
      errors: [],
    },
  });
});

it("returns candidate reads larger than the reader's stdout buffer intact", async () => {
  // About 1 MB: well past macOS pipe and Linux socketpair buffers.
  const { root, dist } = await candidateFixture(
    "large",
    simpleRuntime('{ valid: true, text: "🦞 café ".repeat(100_000) }', "", true),
  );
  writeStableRootRuntimeAliases({ rootDir: root });
  const script = `
const expected = { valid: true, text: "🦞 café ".repeat(100_000) };
const reader = await import(${moduleUrl(path.join(dist, "io.runtime.js"))});
assert.deepEqual(await reader.readConfigFileSnapshot(), expected);
assert.deepEqual(await reader.createConfigIO().readConfigFileSnapshot(), expected);
assert.deepEqual(reader.readCurrentConfigForPolicyCheck(), expected);
assert.deepEqual(reader.createConfigIO().loadConfig(), expected);
`;
  runScript(script);
});

it("reports a reader exit without a result while withholding the reader's stderr", async () => {
  const { root, dist } = await candidateFixture(
    "exit",
    simpleRuntime(
      "{ valid: true }",
      `if (process.env.OPENCLAW_CONFIG_READ_CHILD === "1") {
  process.stderr.write("synthetic-config-secret\\n");
  process.exit(7);
}`,
    ),
  );
  writeStableRootRuntimeAliases({ rootDir: root });
  const script = `
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));
const reader = await import(${moduleUrl(path.join(dist, "io.runtime.js"))});
await assert.rejects(reader.readConfigFileSnapshot(), { code: "candidate-config-read-failed" });
assert.throws(() => reader.readCurrentConfigForPolicyCheck(), { code: "candidate-config-read-failed" });
console.log(JSON.stringify(warnings));
`;
  const result = runScript(script, { timeout: 10_000 });
  expect(JSON.parse(result)).toEqual(
    Array.from(
      { length: 2 },
      () =>
        "[update:warning:candidate-config-read-failed] Candidate config read failed: reader process exited with code 7 without a result. The existing service definition was left unchanged. After the update finishes, run openclaw gateway install --force with the same --profile or --dev option as this update to refresh it.",
    ),
  );
});

it("reads candidate config after a package swap without reusing the driver's dependencies", async () => {
  const { root, dist } = await candidateFixture(
    "runtime",
    `import { probePathCaseInsensitiveSync } from "handoff-dependency/advanced";
if (process.env.OPENCLAW_CONFIG_READ_CHILD === "1") {
  console.log("reader stdout diagnostic");
  process.stdout.write("reader stdout chunk\\n");
}
export function createConfigIO(options = {}) {
  return {
    readBestEffortConfig: async () => ({
      generation: probePathCaseInsensitiveSync(),
      pid: process.pid,
      cwd: process.cwd(),
      selection: options.env?.OPENCLAW_CONFIG_PATH,
      text: "🦞 café",
    }),
    readConfigFileSnapshot: async () => ({ valid: true, generation: probePathCaseInsensitiveSync() }),
    loadConfig: () => ({ generation: probePathCaseInsensitiveSync() }),
  };
}
export async function readConfigFileSnapshot() { return createConfigIO().readConfigFileSnapshot(); }
export function readCurrentConfigForPolicyCheck() { return createConfigIO().loadConfig(); }
export function normalRuntimeApi() { return process.pid; }
`,
    {
      "node_modules/handoff-dependency/package.json": JSON.stringify({
        type: "module",
        exports: { "./advanced": "./advanced.js" },
      }),
      "node_modules/handoff-dependency/advanced.js": "export const generation = 1;\n",
      "dist/current-consumer.mjs": 'export { createConfigIO } from "./io.runtime-Candidate.mjs";\n',
      "dist/previous-runtime.mjs": `import { generation } from "handoff-dependency/advanced";
     export function createConfigIO() {
       return { readBestEffortConfig: async () => ({ generation }) };
     }
     export async function readConfigFileSnapshot() { return { generation }; }`,
    },
  );
  const dependencyFile = path.join(root, "node_modules", "handoff-dependency", "advanced.js");
  const currentEntry = path.join(dist, "current-consumer.mjs");
  rewriteRootRuntimeImportsToStableAliases({ rootDir: root });
  writeStableRootRuntimeAliases({ rootDir: root });

  const script = `
import fs from "node:fs/promises";
const dependency = ${moduleUrl(dependencyFile)};
const aliasPath = ${JSON.stringify(path.join(dist, "io.runtime.js"))};
const candidatePath = ${JSON.stringify(path.join(dist, "io.runtime-Candidate.mjs"))};
const aliasBytes = await fs.readFile(aliasPath);
const candidateBytes = await fs.readFile(candidatePath);
${diagnosticsScript}
const driverDependency = await import(dependency);
assert.equal(driverDependency.generation, 1);
await fs.writeFile(new URL(dependency), "export const generation = 2; export function probePathCaseInsensitiveSync() { return generation; }\\n");
process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
const runtime = await import(${moduleUrl(path.join(dist, "io.runtime.js"))});
const io = runtime.createConfigIO({ env: { ...process.env, OPENCLAW_CONFIG_PATH: "synthetic-config-selection" } });
const { pid, ...config } = await io.readBestEffortConfig();
assert.notEqual(pid, process.pid);
assert.deepEqual(config, { generation: 2, cwd: ${JSON.stringify(root)}, selection: "synthetic-config-selection", text: "🦞 café" });
assert.equal((await runtime.readConfigFileSnapshot()).generation, 2);
assert.equal((await io.readConfigFileSnapshot()).valid, true);
assert.equal(io.loadConfig().generation, 2);
assert.equal(runtime.readCurrentConfigForPolicyCheck().generation, 2);
assert.equal((await import(dependency)).generation, 1);
await fs.unlink(new URL(dependency));
const fallback = await io.readBestEffortConfig().catch(error => {
  assert.equal(error.code, "candidate-config-read-failed");
  return {};
});
assert.deepEqual(fallback, {});
await fs.writeFile(new URL(dependency), "export const generation = 1;\\n");
await fs.writeFile(aliasPath, 'export * from "./previous-runtime.mjs";');
await fs.unlink(candidatePath);
assert.equal((await io.readBestEffortConfig()).generation, 1);
assert.equal((await runtime.readConfigFileSnapshot()).generation, 1);
await fs.writeFile(candidatePath, candidateBytes);
await fs.writeFile(aliasPath, aliasBytes);
await fs.writeFile(new URL(dependency), "export function probePathCaseInsensitiveSync() { return 2; }\\n");
assert.equal((await io.readBestEffortConfig()).generation, 2);
console.log(JSON.stringify(diagnostics));
`;
  const result = runScript(script, {
    root: path.dirname(root),
    env: {
      OPENCLAW_UPDATE_IN_PROGRESS: process.env.OPENCLAW_UPDATE_IN_PROGRESS,
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
  });
  expect(JSON.parse(result)).toEqual({
    warnings: [
      `[update:warning:candidate-config-read-failed] Candidate config read failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${dependencyFile}' imported from ${path.join(dist, "io.runtime-Candidate.mjs")}. The existing service definition was left unchanged. After the update finishes, run openclaw gateway install --force with the same --profile or --dev option as this update to refresh it.`,
    ],
    errors: [],
  });

  for (const { marker, entry } of [
    { marker: "0", entry: path.join(dist, "io.runtime.js") },
    { marker: "1", entry: currentEntry },
  ]) {
    runScript(
      `const runtime = await import(${moduleUrl(entry)});
       const result = await runtime.createConfigIO().readBestEffortConfig();
       assert.equal(result.generation, 2);
       if (${JSON.stringify(marker)} === "0") {
         assert.equal(runtime.normalRuntimeApi(), process.pid);
         assert.equal(result.pid, process.pid);
       } else {
         assert.notEqual(result.pid, process.pid);
       }`,
      {
        env: {
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_UPDATE_IN_PROGRESS: marker,
        },
      },
    );
  }
});
