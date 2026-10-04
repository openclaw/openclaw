import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

type FailedAcquisitionResult = {
  failure: string;
  loadError: string;
  marker: string;
  rejected: string;
  afterFailedDispose: string;
};

it("releases a native ESM owner when source validation rejects the capture", async () => {
  const stateDir = temp.make("plugin-failed-acquisition-state-");
  const sourceCaptureDirectory = path.join(stateDir, "captures");
  const rootDir = temp.make("plugin-failed-acquisition-");
  fs.mkdirSync(sourceCaptureDirectory);
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "failed-acquisition-fixture", type: "module" }),
  );
  fs.writeFileSync(path.join(rootDir, "index.mjs"), 'export const marker = "loaded";\n');
  fs.writeFileSync(path.join(rootDir, "side.mjs"), 'export const value = "side";\n');
  const workerPath = path.resolve(
    "src/plugins/plugin-instance-module-loader.failed-acquisition.worker.ts",
  );
  const workerUrl = pathToFileURL(workerPath);
  const worker = new Worker(workerUrl, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
    workerData: { rootDir, sourceCaptureDirectory },
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  let stderr = "";
  worker.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });
  try {
    const [message] = (await once(worker, "message")) as [FailedAcquisitionResult];
    expect(message.failure).toContain("source changed after installation");
    expect(message.loadError, stderr).toBe("");
    expect(message.marker).toBe("loaded");
    expect(message.rejected).toContain("no live workspace owner");
    expect(message.afterFailedDispose).toBe("loaded");
  } finally {
    await worker.terminate();
  }
});
