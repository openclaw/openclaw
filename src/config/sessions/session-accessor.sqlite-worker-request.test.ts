import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runSqliteMutationWorkerRequest } from "./session-accessor.sqlite-worker-request.js";

test("runs reused Worker request callbacks in the requesting operation context", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.postMessage({ type: "commit-request", operationId: 7 });
     parentPort.postMessage({ type: "reclaimed", operationId: 7, result: "done", settled: true });`,
    { eval: true, execArgv: [] },
  );
  const owner = new AsyncLocalStorage<string>();
  const observed: Array<{ event: string; owner: string | undefined }> = [];
  try {
    await expect(
      owner.run("request-7", () =>
        runSqliteMutationWorkerRequest({
          worker,
          operationId: 7,
          completion: "exit",
          onCommitRequest: () => {
            observed.push({ event: "message", owner: owner.getStore() });
          },
          onExit: () => {
            observed.push({ event: "exit", owner: owner.getStore() });
          },
          withWriteAdmission: async () => {
            throw new Error("Synthetic Worker must not request write admission");
          },
        }),
      ),
    ).resolves.toBe("done");
    expect(observed).toEqual([
      { event: "message", owner: "request-7" },
      { event: "exit", owner: "request-7" },
    ]);
  } finally {
    await worker.terminate();
  }
});

test("joins native exit before rejecting a Worker initialization error", async () => {
  const worker = new Worker(
    `void import('data:text/javascript,throw new Error("worker module initialization failed")');`,
    { eval: true, execArgv: [] },
  );
  const events: string[] = [];
  let observedError: unknown;
  worker.once("error", (error) => {
    observedError = error;
    events.push("error");
  });
  worker.once("exit", () => events.push("exit"));
  const onCommitRequest = vi.fn();
  const withWriteAdmission = vi.fn(async () => {
    throw new Error("Failed initialization must not request write admission");
  });
  const outcome = runSqliteMutationWorkerRequest({
    worker,
    operationId: 1,
    completion: "exit",
    onCommitRequest,
    withWriteAdmission,
  }).then(
    () => {
      events.push("resolved");
    },
    (error: unknown) => {
      events.push("rejected");
      return error;
    },
  );
  try {
    const failure = await outcome;
    expect(observedError).toMatchObject({ message: "worker module initialization failed" });
    expect(failure).toBe(observedError);
    expect(events).toEqual(["error", "exit", "rejected"]);
    expect(worker.threadId).toBe(-1);
    expect(onCommitRequest).not.toHaveBeenCalled();
    expect(withWriteAdmission).not.toHaveBeenCalled();
  } finally {
    await worker.terminate();
    await outcome;
  }
});

test("joins queued admission after Worker exit without granting the dead Worker", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.on("message", () => {});
     parentPort.postMessage({ type: "admission-request", operationId: 8, admissionId: 1 });`,
    { eval: true, execArgv: [] },
  );
  const queued = createDeferred();
  const releaseAdmission = createDeferred();
  const postMessage = vi.spyOn(worker, "postMessage");
  const onCommitRequest = vi.fn();
  let admissionSettled = false;
  let requestSettled = false;
  let admissionTask: Promise<void> | undefined;
  const outcome = runSqliteMutationWorkerRequest({
    worker,
    operationId: 8,
    completion: "result",
    onCommitRequest,
    withWriteAdmission: (run) => {
      admissionTask = (async () => {
        queued.resolve();
        await releaseAdmission.promise;
        await run();
        admissionSettled = true;
      })();
      return admissionTask;
    },
  })
    .catch((error: unknown) => error)
    .finally(() => {
      requestSettled = true;
    });
  try {
    await Promise.race([queued.promise, outcome]);
    expect(requestSettled).toBe(false);
    const exitCode = await worker.terminate();
    expect(worker.threadId).toBe(-1);
    await nextTurn();
    expect(requestSettled).toBe(false);
    expect(admissionSettled).toBe(false);

    releaseAdmission.resolve();
    await expect(outcome).resolves.toMatchObject({
      message: `SQLite transcript archive worker exited with code ${exitCode}`,
    });
    expect(admissionSettled).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(onCommitRequest).not.toHaveBeenCalled();
  } finally {
    releaseAdmission.resolve();
    await worker.terminate();
    await Promise.allSettled([outcome, admissionTask]);
    postMessage.mockRestore();
  }
});
