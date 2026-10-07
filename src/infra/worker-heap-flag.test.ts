import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { hasProcessHeapFlag } from "../../worker-heap-flag.mjs";
import { resolveCatalogWorkerHeapLimitMb } from "../agents/prepared-model-catalog-worker.pool.js";

const moduleUrl = new URL("../../worker-heap-flag.mjs", import.meta.url).href;

function workerHeapLimitMb(env: NodeJS.ProcessEnv): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heap-flag-"));
  try {
    const worker = path.join(dir, "worker.cjs");
    fs.writeFileSync(
      worker,
      "require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit);",
    );
    const main = path.join(dir, "main.mjs");
    fs.writeFileSync(
      main,
      [
        `await import(${JSON.stringify(moduleUrl)});`,
        `const { Worker } = await import("node:worker_threads");`,
        `const w = new Worker(${JSON.stringify(worker)}, { resourceLimits: { maxOldGenerationSizeMb: 512 } });`,
        `w.once("message", (m) => { console.log(Math.round(m / 1048576)); void w.terminate(); });`,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [main], {
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096", ...env },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return Number(result.stdout.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

it("detects heap flags in NODE_OPTIONS and execArgv", () => {
  expect(hasProcessHeapFlag({ NODE_OPTIONS: "--max-old-space-size=4096" }, [])).toBe(true);
  expect(hasProcessHeapFlag({}, ["--max_old_space_size=4096"])).toBe(true);
  expect(hasProcessHeapFlag({ NODE_OPTIONS: "--dns-result-order=ipv4first" }, [])).toBe(false);
});

it("lets worker resourceLimits apply under a process-wide heap flag", () => {
  expect(workerHeapLimitMb({})).toBeLessThan(1024);
});

it("keeps the old behaviour when opted out", () => {
  expect(workerHeapLimitMb({ OPENCLAW_WORKER_HEAP_FLAG_RESET: "0" })).toBeGreaterThan(4000);
});

it("bounds the catalog worker heap override", () => {
  expect(resolveCatalogWorkerHeapLimitMb({})).toBe(512);
  expect(resolveCatalogWorkerHeapLimitMb({ OPENCLAW_CATALOG_WORKER_HEAP_MB: "2048" })).toBe(2048);
  expect(resolveCatalogWorkerHeapLimitMb({ OPENCLAW_CATALOG_WORKER_HEAP_MB: "64" })).toBe(512);
});
