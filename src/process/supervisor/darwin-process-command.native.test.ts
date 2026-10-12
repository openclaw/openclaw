import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { readDarwinProcessCommand } from "./darwin-process-command.js";

it.runIf(process.platform === "darwin")(
  "inspects exact child arguments and selected environment on the main thread and a Worker",
  async ({ signal }) => {
    const args = ["/app with spaces/openclaw.mjs", "", '"quoted"', "工作"];
    const child = spawn(
      process.execPath,
      [
        "--eval",
        "process.on('message', () => process.exit(0)); process.send('ready');",
        "--",
        ...args,
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_SERVICE_MARKER: "native-inspection-fixture",
          UNRELATED_PRIVATE_VALUE: "must-not-escape",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const closed = once(child, "close");
    void closed.catch(() => {});
    let worker: Worker | undefined;
    try {
      await Promise.race([
        once(child, "message", { signal }),
        closed.then(() => {
          throw new Error("Inspection fixture exited before readiness");
        }),
      ]);
      const translated = process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");
      const inspect = () => readDarwinProcessCommand(child.pid!, process.getuid?.());
      if (translated) {
        expect(inspect).toThrow(/under Rosetta/);
      } else {
        const observed = inspect();
        expect(observed).toEqual({
          argv: [
            process.execPath,
            "--eval",
            "process.on('message', () => process.exit(0)); process.send('ready');",
            "--",
            ...args,
          ],
          executable: process.execPath,
          serviceMarker: "native-inspection-fixture",
        });
      }
      worker = new Worker(
        `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        if (!process.versions.bun) { (await import(workerData.loader)).register(); }
        const { readDarwinProcessCommand } = await import(workerData.module);
        try { parentPort.postMessage({ command: readDarwinProcessCommand(workerData.pid, workerData.uid) }); }
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
            uid: process.getuid?.(),
          },
        },
      );
      const [result] = await once(worker, "message", { signal });
      if (translated) {
        expect(result).toEqual({ error: expect.stringMatching(/under Rosetta/) });
      } else {
        expect(result).toEqual({
          command: {
            argv: [
              process.execPath,
              "--eval",
              "process.on('message', () => process.exit(0)); process.send('ready');",
              "--",
              ...args,
            ],
            executable: process.execPath,
            serviceMarker: "native-inspection-fixture",
          },
        });
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
