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

it("reads candidate config after a package swap without reusing the driver's dependencies", async () => {
  const root = tempDirs.make("openclaw-update-config-runtime-");
  const dist = path.join(root, "dist");
  const dependency = path.join(root, "node_modules", "handoff-dependency");
  await fs.mkdir(dist);
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({ type: "module", exports: { "./advanced": "./advanced.js" } }),
  );
  const dependencyFile = path.join(dependency, "advanced.js");
  await fs.writeFile(dependencyFile, "export const generation = 1;\n");
  await fs.writeFile(
    path.join(dist, "io.runtime-Candidate.mjs"),
    `import { probePathCaseInsensitiveSync } from "handoff-dependency/advanced";
export function createConfigIO(options = {}) {
  return {
    readBestEffortConfig: async () => ({
      generation: probePathCaseInsensitiveSync(),
      pid: process.pid,
      cwd: process.cwd(),
      selection: options.env?.OPENCLAW_CONFIG_PATH,
    }),
    readConfigFileSnapshot: async () => ({ valid: true, generation: probePathCaseInsensitiveSync() }),
    loadConfig: () => ({ generation: probePathCaseInsensitiveSync() }),
  };
}
export async function readConfigFileSnapshot() {
  return createConfigIO().readConfigFileSnapshot();
}
export function readCurrentConfigForPolicyCheck() {
  return createConfigIO().loadConfig();
}
export function normalRuntimeApi() { return process.pid; }
`,
  );
  const currentEntry = path.join(dist, "current-consumer.mjs");
  await fs.writeFile(
    currentEntry,
    'export { createConfigIO } from "./io.runtime-Candidate.mjs";\n',
  );
  rewriteRootRuntimeImportsToStableAliases({ rootDir: root });
  writeStableRootRuntimeAliases({ rootDir: root });
  await fs.writeFile(
    path.join(dist, "previous-runtime.mjs"),
    `import { generation } from "handoff-dependency/advanced";
     export function createConfigIO() {
       return { readBestEffortConfig: async () => ({ generation }) };
     }
     export async function readConfigFileSnapshot() { return { generation }; }`,
  );

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const dependency = ${JSON.stringify(pathToFileURL(dependencyFile).href)};
const aliasPath = ${JSON.stringify(path.join(dist, "io.runtime.js"))};
const candidatePath = ${JSON.stringify(path.join(dist, "io.runtime-Candidate.mjs"))};
const aliasBytes = await fs.readFile(aliasPath);
const candidateBytes = await fs.readFile(candidatePath);
const driverDependency = await import(dependency);
assert.equal(driverDependency.generation, 1);
await fs.writeFile(new URL(dependency), "export const generation = 2; export function probePathCaseInsensitiveSync() { return generation; }\\n");
process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
const runtime = await import(${JSON.stringify(pathToFileURL(path.join(dist, "io.runtime.js")).href)});
const io = runtime.createConfigIO({ env: { ...process.env, OPENCLAW_CONFIG_PATH: "synthetic-config-selection" } });
const result = await io.readBestEffortConfig();
assert.equal(result.generation, 2);
assert.notEqual(result.pid, process.pid);
assert.equal(result.cwd, ${JSON.stringify(root)});
assert.equal(result.selection, "synthetic-config-selection");
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
`;
  const result = spawnSync(node, ["--input-type=module", "--eval", script], {
    cwd: path.dirname(root),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: "", NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  expect(result.stderr).toContain("[update:warning:candidate-config-read-failed]");
  expect(result.status).toBe(0);

  for (const { marker, entry } of [
    { marker: "0", entry: path.join(dist, "io.runtime.js") },
    { marker: "1", entry: currentEntry },
  ]) {
    const normal = spawnSync(
      node,
      [
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
       const runtime = await import(${JSON.stringify(pathToFileURL(entry).href)});
       const result = await runtime.createConfigIO().readBestEffortConfig();
       assert.equal(result.generation, 2);
       if (${JSON.stringify(marker)} === "0") {
         assert.equal(runtime.normalRuntimeApi(), process.pid);
         assert.equal(result.pid, process.pid);
       } else {
         assert.notEqual(result.pid, process.pid);
       }`,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_UPDATE_IN_PROGRESS: marker,
        },
      },
    );
    expect(normal.stderr).toBe("");
    expect(normal.status).toBe(0);
  }
});
