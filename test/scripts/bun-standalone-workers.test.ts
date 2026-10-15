import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverStandaloneWorkers,
  prepareStandaloneWorkers,
} from "../../scripts/lib/bun-standalone-workers.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-standalone-workers-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const outputRoot = path.join(root, "build");
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(runtimeRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { runtimeRoot, outputRoot };
}

describe("standalone worker discovery", () => {
  it("retains manifest launchers without worker suffixes and adds built plugin workers once", () => {
    const { runtimeRoot } = fixture({
      "dist/process/supervisor/service-child-relay.js": "",
      "dist/process/spawn-broker/worker.js": "",
      "dist/extensions/example/store.worker.mjs": "",
      "dist/worker/memory-worker-entry.js": "",
      "dist/worker/worker-chunk-abc.js": "",
      "dist/telegram-ingress-worker.runtime.js": "",
      "dist/ordinary.mjs": "",
    });
    expect(
      discoverStandaloneWorkers({
        runtimeRoot,
        moduleEntries: Object.keys({
          "dist/process/supervisor/service-child-relay.js": 0,
          "dist/extensions/example/store.worker.mjs": 0,
          "dist/worker/memory-worker-entry.js": 0,
          "dist/worker/worker-chunk-abc.js": 0,
          "dist/telegram-ingress-worker.runtime.js": 0,
          "dist/ordinary.mjs": 0,
        }),
        runtimeEntrypoints: {
          relay: { distWorkerPath: "process/supervisor/service-child-relay.js" },
          broker: { distWorkerPath: "process/spawn-broker/worker.js" },
          duplicate: { distWorkerPath: "process/supervisor/service-child-relay.js" },
        },
      }),
    ).toEqual([
      "dist/extensions/example/store.worker.mjs",
      "dist/process/spawn-broker/worker.js",
      "dist/process/supervisor/service-child-relay.js",
      "dist/telegram-ingress-worker.runtime.js",
      "dist/worker/memory-worker-entry.js",
    ]);
  });

  it("refuses missing launcher outputs before producing an incomplete image", () => {
    const { runtimeRoot } = fixture({ "dist/present.js": "" });
    expect(() =>
      discoverStandaloneWorkers({
        runtimeRoot,
        moduleEntries: [],
        runtimeEntrypoints: { missing: { distWorkerPath: "agents/github-exec-launcher.js" } },
      }),
    ).toThrow("Missing standalone worker outputs: dist/agents/github-exec-launcher.js");
  });
});

describe("standalone inline worker graph", () => {
  it.each([
    ['import { Worker as Task } from "node:worker_threads";', "new Task"],
    ['import * as threads from "worker_threads";', "new threads.Worker"],
    ['const { Worker: Task } = require("node:worker_threads");', "new Task"],
    ['const threads = await import("node:worker_threads");', "new threads.Worker"],
    ['const { Worker: Task } = await import("node:worker_threads");', "new Task"],
    ['import { createCpuTrackedWorker as task } from "./worker-cpu-abc.mjs";', "task"],
  ])("embeds fixed payloads for a recognized worker binding (%s)", (binding, callee) => {
    const source = `${binding}\nconst SOURCE = "require('node:worker_threads').parentPort.postMessage(7)";\n${callee}(SOURCE, { eval: true, workerData: { value: 3 } });`;
    const paths = fixture({ "dist/entry.mjs": source });
    const prepared = prepareStandaloneWorkers({
      ...paths,
      runtimeBootstrap: path.join(paths.outputRoot, "bootstrap.mjs"),
      workerEntries: [],
      moduleEntries: ["dist/entry.mjs"],
      parse,
    });
    expect(prepared.inlineWorkers).toHaveLength(1);
    const transformed = prepared.rewriteInlineWorkers(
      path.join(paths.runtimeRoot, "dist/entry.mjs"),
      source,
    );
    const ast = parse(transformed, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast).toBeDefined();
    expect(transformed).toContain("eval: false");
    expect(transformed).toContain("workerData: { value: 3 }");
    expect(transformed).toContain("file:///$bunfs/root/standalone-workers/inline/");
    const entrypoint = prepared.entrypoints[0];
    assert.ok(entrypoint, "expected embedded worker entrypoint");
    expect(fs.readFileSync(entrypoint.replace(/\.mjs$/, ".body.cjs"), "utf8")).toBe(
      "require('node:worker_threads').parentPort.postMessage(7)\n",
    );
  });

  it("leaves unrelated and shadowed eval options unchanged", () => {
    const source = `import { Worker } from "node:worker_threads";
function unrelated(value, options) { return value; }
unrelated("not worker code", { eval: true });
function useShadow(Worker) { return new Worker("also unrelated", { eval: true }); }`;
    const paths = fixture({ "dist/entry.mjs": source });
    const prepared = prepareStandaloneWorkers({
      ...paths,
      runtimeBootstrap: path.join(paths.outputRoot, "bootstrap.mjs"),
      workerEntries: [],
      moduleEntries: ["dist/entry.mjs"],
      parse,
    });
    expect(prepared.inlineWorkers).toEqual([]);
    expect(
      prepared.rewriteInlineWorkers(path.join(paths.runtimeRoot, "dist/entry.mjs"), source),
    ).toBe(source);
  });
});
