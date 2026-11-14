import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import * as workerCpu from "../../infra/worker-cpu.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";

afterEach(() => vi.restoreAllMocks());

it("collects a large cold-embed result without spreading it as call arguments", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.once("message", () => {
       parentPort.postMessage({ type: "done", results: Array.from({ length: 150_000 }, (_, i) => String(i)) });
       parentPort.close();
     });`,
    { eval: true, execArgv: [] },
  );
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockReturnValueOnce(worker);
  try {
    const operation = archiveWorker.runSqliteTranscriptArchiveWorkerOperation<string>({
      expectedMessageType: "done",
      workerData: {},
    });
    worker.postMessage("go", []);
    const results = await operation;
    expect(results).toHaveLength(150_000);
    expect(results.at(-1)).toBe("149999");
  } finally {
    await worker.terminate();
  }
});
