import { subscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

// Loaded before the fork's tests so blocked teardown cannot hide its last synchronous wait.
if (isMainThread && process.send && process.report.directory) {
  const workers = new Set();
  subscribe("worker_threads", ({ worker }) => {
    workers.add(worker);
    worker.once("exit", () => workers.delete(worker));
  });
  const waitPath = path.join(process.report.directory, "synchronous-wait.json");
  const wait = Atomics.wait;
  Atomics.wait = function (...args) {
    try {
      fs.writeFileSync(
        waitPath,
        JSON.stringify({
          operation: "Atomics.wait",
          startedAt: Date.now(),
          timeoutMs: Number.isFinite(args[3]) ? args[3] : null,
          stack: new Error().stack?.split("\n").slice(1, 9).join("\n"),
        }),
      );
    } catch {
      // Diagnostics cannot change the wait's result or error.
    }
    try {
      return Reflect.apply(wait, this, args);
    } finally {
      try {
        fs.rmSync(waitPath, { force: true });
      } catch {
        // The pool may already have removed its diagnostic directory.
      }
    }
  };
  process.prependListener("SIGUSR2", () => {
    try {
      const handles = process._getActiveHandles();
      fs.writeFileSync(
        path.join(process.report.directory, "active-resources.json"),
        JSON.stringify({
          resources: process.getActiveResourcesInfo().slice(0, 64),
          handles: handles.slice(0, 64).map((handle) => handle.constructor.name),
          children: handles
            .filter((handle) => handle.constructor.name === "ChildProcess")
            .slice(0, 32)
            .map((child) => ({
              pid: child.pid,
              exitCode: child.exitCode,
              signalCode: child.signalCode,
            })),
          workers: [...workers].slice(0, 32).map((worker) => ({ threadId: worker.threadId })),
        }),
      );
    } catch {
      // The parent reports unavailable evidence without interfering with Node's report.
    }
  });
}
