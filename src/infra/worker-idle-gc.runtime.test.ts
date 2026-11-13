import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";

it("collects released payloads in the worker's own heap while preserving live payloads", async () => {
  const url = new URL("./worker-idle-gc.runtime.test-support.ts", import.meta.url);
  const worker = new Worker(url, { execArgv: resolveRuntimeWorkerThreadExecArgv(url) });
  try {
    expect(await once(worker, "message")).toEqual(["collected"]);
  } finally {
    await worker.terminate();
  }
});
