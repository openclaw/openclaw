import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps filesystem census disabled in workers with an explicit environment", async () => {
  const env = { ...process.env };
  delete env.OPENCLAW_IDLE_MEASURE_FS_CENSUS;
  const child = spawn(
    process.execPath,
    [
      "--import",
      path.resolve("scripts/perf/idle-gateway-measure-preload.mjs"),
      "--input-type=module",
      "--eval",
      `
        import { once } from 'node:events';
        import { Worker } from 'node:worker_threads';
        const worker = new Worker(
          "require('node:worker_threads').parentPort.postMessage(process.env.OPENCLAW_IDLE_MEASURE_FS_CENSUS ?? null)",
          { eval: true, env: {}, execArgv: [] },
        );
        const [value] = await once(worker, 'message');
        console.log(JSON.stringify(value));
        await worker.terminate();
      `,
    ],
    {
      env: {
        ...env,
        OPENCLAW_IDLE_MEASURE_CHANNEL: `idle-preload-test-${process.pid}`,
        OPENCLAW_IDLE_MEASURE_TIMERS: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  try {
    const [code] = await once(child, "close");
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe("null");
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
});
