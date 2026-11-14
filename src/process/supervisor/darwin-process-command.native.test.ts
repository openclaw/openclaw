import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { readDarwinProcessCommand } from "./darwin-process-command.js";

it.runIf(process.platform === "darwin")(
  "inspects exact child arguments and selected environment on the main thread and a Worker",
  async ({ signal }) => {
    const args = ["/app with spaces/openclaw.mjs", "", '"quoted"', "工作"];
    const script = "process.on('message', () => process.exit(0)); process.send('ready');";
    const argv = [process.execPath, "--eval", script, "--", ...args];
    const expected = { argv, executable: process.execPath, serviceMarker: "fixture" };
    const child = spawn(process.execPath, argv.slice(1), {
      env: {
        ...process.env,
        OPENCLAW_SERVICE_MARKER: "fixture",
        UNRELATED_PRIVATE_VALUE: "must-not-escape",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    let worker: Worker | undefined;
    try {
      await awaitGateBeforeSettlement(
        once(child, "message", { signal }),
        closed,
        "Inspection fixture exited before readiness",
      );
      const translated = process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");
      const inspect = () => readDarwinProcessCommand(child.pid!, "same");
      if (translated) {
        expect(inspect).toThrow(/under Rosetta/);
      } else {
        expect(inspect()).toEqual(expected);
      }
      worker = new Worker(
        `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        if (!process.versions.bun) { (await import(workerData.loader)).register(); }
        const { readDarwinProcessCommand } = await import(workerData.module);
        try { parentPort.postMessage({ command: readDarwinProcessCommand(workerData.pid, "same") }); }
        catch (error) { parentPort.postMessage({ error: error.message }); }
      })().catch(error => { throw error; });
    `,
        {
          eval: true,
          execArgv: [],
          workerData: {
            loader: import.meta.resolve("tsx/esm/api"),
            module: new URL("./darwin-process-command.ts", import.meta.url).href,
            pid: child.pid,
          },
        },
      );
      const [result] = await once(worker, "message", { signal });
      if (translated) {
        expect(result).toEqual({ error: expect.stringMatching(/under Rosetta/) });
      } else {
        expect(result).toEqual({ command: expected });
      }
      child.send("exit");
      expect(await closed).toEqual([0, null]);
      if (!translated) {
        expect(inspect()).toBeUndefined();
      }
    } finally {
      await worker?.terminate();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed.catch(() => {});
    }
  },
);

it.runIf(
  process.platform === "darwin" &&
    !(process.arch === "x64" && os.cpus()[0]?.model.includes("Apple")),
)("reads a system command whose argument image may omit its environment", async () => {
  // macOS 27 drops envp from hardened executables, even with an inherited marker.
  const child = spawn("/bin/sleep", ["30"], {
    env: { ...process.env, OPENCLAW_SERVICE_MARKER: "fixture" },
    stdio: "ignore",
  });
  try {
    await once(child, "spawn");
    expect(readDarwinProcessCommand(child.pid!, "same")).toMatchObject({
      argv: ["/bin/sleep", "30"],
      executable: "/bin/sleep",
    });
  } finally {
    child.kill("SIGKILL");
  }
});
