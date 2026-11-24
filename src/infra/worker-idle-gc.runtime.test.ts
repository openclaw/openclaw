import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
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

it("collects released resource payloads only after the admitted close queue settles", async () => {
  const url = new URL("./worker-idle-gc.resource-close.test-support.ts", import.meta.url);
  const worker = new Worker(url, { execArgv: resolveRuntimeWorkerThreadExecArgv(url) });
  const task = new MessageChannel();
  const first = new MessageChannel();
  const second = new MessageChannel();
  try {
    expect(await once(worker, "message")).toEqual(["ready"]);
    const started = once(worker, "message");
    const firstReply = once(first.port2, "message");
    const secondReply = once(second.port2, "message");
    worker.postMessage(task.port1, [task.port1]);
    task.port2.postMessage({ closeResource: true, key: "first", resourcePort: first.port1 }, [
      first.port1,
    ]);
    task.port2.postMessage({ closeResource: true, key: "second", resourcePort: second.port1 }, [
      second.port1,
    ]);
    expect(await started).toEqual(["closing"]);
    const collected = once(worker, "message");
    worker.postMessage("release", []);
    expect(await Promise.all([firstReply, secondReply, collected])).toEqual([
      [{ ok: true }],
      [{ ok: true }],
      ["collected"],
    ]);
  } finally {
    await worker.terminate();
    for (const port of [
      task.port1,
      task.port2,
      first.port1,
      first.port2,
      second.port1,
      second.port2,
    ]) {
      port.close();
    }
  }
});
