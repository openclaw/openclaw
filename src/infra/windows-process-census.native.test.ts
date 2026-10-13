import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";
import { readWindowsProcessCensus } from "./windows-process-census.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "win32")(
  "observes a retained-cwd descendant and proves its exit",
  { timeout: 30_000 },
  async ({ signal }) => {
    const retained = path.join(temp.make("openclaw-handoff-census-"), "retained 工作");
    fs.mkdirSync(retained);
    const child = spawn(
      process.execPath,
      [
        "--eval",
        "process.on('message', () => process.exit(0)); process.on('disconnect', () => process.exit(1)); process.send('ready');",
      ],
      {
        cwd: retained,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    const closed = once(child, "close");
    void closed.catch(() => {});
    let worker: Worker | undefined;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await Promise.race([
        once(child, "message", { signal }),
        closed.then(() => {
          throw new Error(`Census fixture closed before readiness: ${stderr}`);
        }),
      ]);
      const observed = [...readWindowsProcessCensus(15_000)].find(
        (entry) => entry.pid === child.pid,
      );
      expect(observed?.parentPid).toBe(process.pid);
      expect(observed?.startIdentity).toMatch(/^\d+$/);
      expect(observed?.commandLine).toContain("process.send('ready')");
      expect(path.resolve(observed?.cwd ?? "").toLowerCase()).toBe(retained.toLowerCase());
      expect(observed?.foreignOwner).toBeUndefined();
      worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          if (!process.versions.bun) { (await import(workerData.loader)).register(); }
          const { readWindowsProcessCensus } = await import(workerData.module);
          parentPort.postMessage(readWindowsProcessCensus(15000).find(row => row.pid === workerData.pid));
        })().catch(error => { throw error; });
      `,
        {
          eval: true,
          execArgv: [],
          workerData: {
            loader: import.meta.resolve("tsx/esm/api"),
            module: new URL("./windows-process-census.ts", import.meta.url).href,
            pid: child.pid,
          },
        },
      );
      const [workerObserved] = await once(worker, "message", { signal });
      expect(workerObserved).toEqual(observed);
      // The run ID is absent from argv: matching this child requires native cwd inspection.
      const census = inspectOtherOpenClawProcesses({
        runId: "absent-fixture-run",
        artifactPaths: [retained],
      });
      expect(census.matchingPids).toContain(child.pid);
      expect(census.unverifiedPids).toEqual([]);
      expect(census.error).toBeUndefined();
      child.send("exit");
      expect(await closed, stderr).toEqual([0, null]);
      expect(
        [...readWindowsProcessCensus(15_000)].find((entry) => entry.pid === child.pid)
          ?.startIdentity,
      ).not.toBe(observed?.startIdentity);
    } finally {
      await worker?.terminate();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed.catch(() => {});
    }
  },
);
