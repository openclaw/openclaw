import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, expect, it } from "vitest";
import {
  discoverStandaloneWorkers,
  prepareStandaloneWorkers,
} from "../../scripts/lib/bun-standalone-workers.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(files: Record<string, string>) {
  const runtimeRoot = tempDirs.make("openclaw-standalone-workers-");
  writeFixtureFiles(runtimeRoot, files);
  return runtimeRoot;
}

function discover(files: Record<string, string>, launchers = {}, modules = Object.keys(files)) {
  return discoverStandaloneWorkers({
    runtimeRoot: fixture(files),
    moduleEntries: modules,
    runtimeEntrypoints: launchers,
    parse,
  });
}

function prepare(source: string) {
  const runtimeRoot = fixture({ "dist/entry.mjs": source });
  const outputRoot = path.join(runtimeRoot, "build");
  fs.mkdirSync(outputRoot);
  const prepared = prepareStandaloneWorkers({
    runtimeRoot,
    outputRoot,
    runtimeBootstrap: path.join(outputRoot, "bootstrap.mjs"),
    workerEntries: [],
    moduleEntries: ["dist/entry.mjs"],
    parse,
  });
  const rewrite = () =>
    prepared.rewriteInlineWorkers(path.join(runtimeRoot, "dist/entry.mjs"), source);
  return { ...prepared, rewrite };
}

const workerBody = "require('node:worker_threads').parentPort.postMessage(7)";
function expectBody(entrypoint: string | undefined) {
  assert.ok(entrypoint, "expected embedded worker entrypoint");
  expect(fs.readFileSync(entrypoint.replace(/\.mjs$/, ".body.cjs"), "utf8")).toBe(
    `${workerBody}\n`,
  );
}

it("embeds self-targeted workers in root modules and emitted chunks", () => {
  const files = {
    "node-compile-cache.mjs":
      'import { Worker as CacheWorker } from "node:worker_threads"; new CacheWorker(new URL(import.meta.url));',
    "dist/node-compile-cache-chunk.mjs":
      'import * as threads from "node:worker_threads"; new threads.Worker(new URL(import.meta.url));',
    "dist/ordinary.mjs": "const location = new URL(import.meta.url);",
    "dist/shadowed.mjs":
      'import { Worker } from "node:worker_threads"; function local(Worker) { return new Worker(new URL(import.meta.url)); }',
  };
  expect(discover(files)).toEqual(["dist/node-compile-cache-chunk.mjs", "node-compile-cache.mjs"]);
});

it("retains manifest launchers without worker suffixes and adds built plugin workers once", () => {
  const files = {
    "dist/process/supervisor/service-child-relay.js": "",
    "dist/process/spawn-broker/worker.js": "",
    "dist/extensions/example/store.worker.mjs": "",
    "dist/worker/memory-worker-entry.js": "",
    "dist/worker/worker-chunk-abc.js": "",
    "dist/telegram-ingress-worker.runtime.js": "",
    "dist/ordinary.mjs": "",
  };
  const runtimeEntrypoints = {
    relay: { distWorkerPath: "process/supervisor/service-child-relay.js" },
    broker: { distWorkerPath: "process/spawn-broker/worker.js" },
    duplicate: { distWorkerPath: "process/supervisor/service-child-relay.js" },
  };
  const moduleEntries = Object.keys(files).filter((entry) => !entry.includes("spawn-broker"));
  expect(discover(files, runtimeEntrypoints, moduleEntries)).toEqual([
    "dist/extensions/example/store.worker.mjs",
    "dist/process/spawn-broker/worker.js",
    "dist/process/supervisor/service-child-relay.js",
    "dist/telegram-ingress-worker.runtime.js",
    "dist/worker/memory-worker-entry.js",
  ]);
});

it("refuses missing launcher outputs before producing an incomplete image", () => {
  expect(() =>
    discover({}, { missing: { distWorkerPath: "agents/github-exec-launcher.js" } }),
  ).toThrow("Missing standalone worker outputs: dist/agents/github-exec-launcher.js");
});
it.each([
  "function unrelated() { let SOURCE; SOURCE = dynamicValue(); }",
  "function unrelated(SOURCE) { SOURCE = dynamicValue(); }",
  "function unrelated() { SOURCE = dynamicValue(); var SOURCE; }",
])("keeps lazy module source separate from shadowed assignments: %s", (unrelated) => {
  const source = `import { Worker } from "node:worker_threads";
var SOURCE;
const initialize = () => { SOURCE = ${JSON.stringify(workerBody)}; };
${unrelated}
function launch() { return new Worker(SOURCE, { eval: true }); }`;
  expectBody(prepare(source).entrypoints[0]);
});

it("refuses a dynamic worker source that shadows a fixed module binding", () => {
  expect(() =>
    prepare(`import { Worker } from "node:worker_threads";
const SOURCE = "wrong program";
function launch(SOURCE) { return new Worker(SOURCE, { eval: true }); }`),
  ).toThrow("Unsupported fixed worker source expression: Identifier SOURCE");
});

it.each([
  ['import { Worker as Task } from "node:worker_threads";', "new Task"],
  ['import * as threads from "worker_threads";', "new threads.Worker"],
  ['const { Worker: Task } = require("node:worker_threads");', "new Task"],
  ['const threads = await import("node:worker_threads");', "new threads.Worker"],
  ['const { Worker: Task } = await import("node:worker_threads");', "new Task"],
  ['import { createCpuTrackedWorker as task } from "./worker-cpu-abc.mjs";', "task"],
])("embeds fixed payloads for a recognized worker binding (%s)", (binding, callee) => {
  const source = `${binding}\nconst SOURCE = ${JSON.stringify(workerBody)};\n${callee}(SOURCE, { eval: true, workerData: { value: 3 } });`;
  const prepared = prepare(source);
  expect(prepared.inlineWorkers).toHaveLength(1);
  const transformed = prepared.rewrite();
  const ast = parse(transformed, { ecmaVersion: "latest", sourceType: "module" });
  expect(ast).toBeDefined();
  expect(transformed).toContain("eval: false");
  expect(transformed).toContain("workerData: { value: 3 }");
  expect(transformed).toContain("file:///$bunfs/root/standalone-workers/inline/");
  expectBody(prepared.entrypoints[0]);
});

it("leaves unrelated and shadowed eval options unchanged", () => {
  const source = `import { Worker } from "node:worker_threads";
function unrelated(value, options) { return value; }
unrelated("not worker code", { eval: true });
function useShadow(Worker) { return new Worker("also unrelated", { eval: true }); }`;
  const prepared = prepare(source);
  expect(prepared.inlineWorkers).toEqual([]);
  expect(prepared.rewrite()).toBe(source);
});
