import { afterEach, expect, vi } from "vitest";

const workerGuard = vi.hoisted(() => {
  let launches = 0;
  return {
    forbiddenLaunch: function forbiddenLaunch(this: void): never {
      launches += 1;
      throw new Error("Worker-free Gateway fixture attempted to launch a worker");
    },
    takeLaunchCount: () => {
      const count = launches;
      launches = 0;
      return count;
    },
  };
});

// Inert metadata avoids compiling worker bundles; actual launches still fail.
vi.mock("../infra/runtime-process-entrypoints.js", () => {
  const unusedWorker = {
    currentModuleUrl: "file:///openclaw-worker-free-test/entry.js",
    sourceWorkerName: "unused-worker",
    distWorkerPath: "unused-worker.js",
  };
  return {
    runtimeProcessEntrypoints: new Proxy({}, { get: () => unusedWorker }),
    SQLITE_READONLY_CHILD_ARG: "unused-worker",
  };
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: workerGuard.forbiddenLaunch,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: workerGuard.forbiddenLaunch,
  fork: workerGuard.forbiddenLaunch,
}));

afterEach(() => {
  expect(workerGuard.takeLaunchCount()).toBe(0);
});
