import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyNativeCompilerPackage } from "./native-boundary-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "linux")(
  "can execute a copied native compiler while sibling-forked children are alive",
  async () => {
    const require = createRequire(import.meta.url);
    const nativeRequire = createRequire(require.resolve("typescript/package.json"));
    const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
    const source = path.dirname(nativeRequire.resolve(`${nativeName}/package.json`));
    const destination = path.join(tempDirs.make("openclaw-native-copy-"), "compiler");
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(
      `
        const { spawn } = require("node:child_process");
        const { once } = require("node:events");
        const { parentPort, workerData } = require("node:worker_threads");
        const control = new Int32Array(workerData);
        const children = [];
        const closed = [];
        const ready = [];
        const cleanup = once(parentPort, "message");
        (async () => {
          try {
            while (Atomics.load(control, 0) === 0 && children.length < 256) {
              const child = spawn("sh", ["-c", "printf .; exec sleep 30"], {
                stdio: ["ignore", "pipe", "ignore"],
              });
              children.push(child);
              closed.push(new Promise(resolve => child.once("close", resolve)));
              // The spawn event can precede deferred close-on-exec release in the
              // kernel. A byte from userspace proves that release has finished.
              const childReady = new Promise(resolve => {
                child.stdout.once("data", () => resolve(true));
                child.stdout.once("end", () => resolve(false));
                child.once("error", () => resolve(false));
              });
              ready.push(childReady);
              if (children.length === 1) parentPort.postMessage("started");
              await childReady;
            }
            const results = await Promise.all(ready);
            parentPort.postMessage(results.every(Boolean));
            await cleanup;
          } finally {
            for (const child of children) child.kill("SIGKILL");
            await Promise.allSettled([...ready, ...closed]);
            parentPort.close();
          }
        })();
      `,
      { eval: true, workerData: control.buffer },
    );
    const exited = once(worker, "exit");
    try {
      await once(worker, "message");
      const stopped = once(worker, "message");
      copyNativeCompilerPackage(source, destination);
      Atomics.store(control, 0, 1);
      const [ready] = await stopped;
      expect(ready, "sibling children must reach userspace").toBe(true);
      const result = spawnSync(path.join(destination, "lib/tsc"), ["--version"], {
        encoding: "utf8",
      });
      expect(
        result.error,
        "copied compiler must not be held writable by a sibling's child",
      ).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      Atomics.store(control, 0, 1);
      worker.postMessage("cleanup", []);
      await exited;
    }
  },
);
