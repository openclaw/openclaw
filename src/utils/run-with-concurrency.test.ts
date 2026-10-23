import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runTasksWithConcurrency } from "./run-with-concurrency.js";

const wait = (promise: Promise<unknown>) => withTestTimeout(promise, 1_000, "task did not settle");
const failTask = (error: Error) => () => Promise.reject(error);
function heldTask(value: number) {
  const started = createDeferred();
  const release = createDeferred();
  const run = vi.fn(() => {
    started.resolve();
    return release.promise.then(() => value);
  });
  return { run, started: started.promise, release: release.resolve };
}

it("keeps pending promise allocation bounded when the task list grows", async () => {
  async function countPendingPromises(taskCount: number): Promise<number> {
    const limit = 8;
    const started = createDeferred();
    const release = createDeferred();
    let startedCount = 0;
    let promiseCount = 0;
    const tasks = Array.from({ length: taskCount }, (_, index) => async () => {
      if (++startedCount === limit) {
        started.resolve();
      }
      await release.promise;
      return index;
    });
    const scope = new AsyncLocalStorage<boolean>();
    const hook = createHook({
      init(_id, type) {
        if (type === "PROMISE" && scope.getStore()) {
          promiseCount += 1;
        }
      },
    });
    hook.enable();
    const run = scope.run(true, () => runTasksWithConcurrency({ tasks, limit }));
    try {
      await wait(started.promise);
      return promiseCount;
    } finally {
      hook.disable();
      scope.disable();
      release.resolve();
      expect((await run).results).toEqual(Array.from({ length: taskCount }, (_, index) => index));
    }
  }

  const smallQueue = await countPendingPromises(32);
  const largeQueue = await countPendingPromises(4_096);
  // Pending async resources follow concurrency, not the number of unstarted tasks.
  expect(largeQueue).toBeLessThanOrEqual(smallQueue * 2);
});

it.each([false, true])(
  "isolates task contexts when the error hook throws (throwOnError=%s)",
  async (throwOnError) => {
    const scope = new AsyncLocalStorage<string>();
    async function runCaller(caller: string) {
      const taskError = new Error("task failed");
      const hookError = new Error("error hook failed");
      const completed = createDeferred();
      const taskContext = `${caller}/task`;
      const contexts: Array<string | undefined> = [];
      const onTaskError = vi.fn(() => {
        contexts.push(scope.getStore());
        scope.enterWith(`${caller}/hook`);
        throw hookError;
      });
      const run = scope.run(caller, () =>
        runTasksWithConcurrency({
          tasks: [
            async () => {
              contexts.push(scope.getStore());
              scope.enterWith(taskContext);
              await Promise.resolve();
              contexts.push(scope.getStore());
              throw taskError;
            },
            async () => {
              contexts.push(scope.getStore());
              completed.resolve();
              return 20;
            },
          ],
          limit: 1,
          throwOnError,
          onTaskError,
        }),
      );
      const observed = scope.run(`${caller}/observer`, () =>
        run.finally(() => expect(scope.getStore()).toBe(`${caller}/observer`)),
      );
      if (throwOnError) {
        await expect(observed).rejects.toBe(hookError);
      } else {
        const expected = { results: [undefined, 20], firstError: taskError, hasError: true };
        await expect(observed).resolves.toEqual(expected);
      }
      await wait(completed.promise);
      expect(contexts).toEqual([caller, taskContext, taskContext, caller]);
      expect(onTaskError).toHaveBeenCalledExactlyOnceWith(taskError, 0);
    }
    try {
      await Promise.all([runCaller("first"), runCaller("second")]);
    } finally {
      scope.disable();
    }
  },
);

it("retains the submitted factories when the caller changes its task array", async () => {
  const first = heldTask(10);
  const tasks = [first.run, async () => 20];
  const run = runTasksWithConcurrency({ tasks, limit: 1 });
  try {
    await wait(first.started);
    tasks[1] = async () => 30;
    tasks.push(async () => 40);
    first.release();
    expect((await run).results).toEqual([10, 20]);
  } finally {
    first.release();
    await run;
  }
});

it("preserves task order with bounded worker count", async () => {
  const jobs = [heldTask(1), heldTask(2), heldTask(3), heldTask(4)] as const;
  const [first, second, third, fourth] = jobs;
  const resultPromise = runTasksWithConcurrency({ tasks: jobs.map((job) => job.run), limit: 2 });
  await wait(Promise.all([first.started, second.started]));
  expect(jobs.map((job) => job.run.mock.calls.length)).toEqual([1, 1, 0, 0]);
  second.release();
  await wait(third.started);
  expect(fourth.run).not.toHaveBeenCalled();
  first.release();
  await wait(fourth.started);
  third.release();
  fourth.release();
  await expect(resultPromise).resolves.toEqual({
    hasError: false,
    firstError: undefined,
    results: [1, 2, 3, 4],
  });
});

it("continues after failures and reports the first one", async () => {
  const firstErr = new Error("first");
  const secondErr = new Error("second");
  const onTaskError = vi.fn();
  const result = await runTasksWithConcurrency({
    tasks: [failTask(firstErr), async () => 20, failTask(secondErr), async () => 40],
    limit: 1,
    errorMode: "continue",
    onTaskError,
  });
  expect(result).toMatchObject({ hasError: true, results: [undefined, 20, undefined, 40] });
  expect(result.firstError).toBe(firstErr);
  expect(onTaskError).toHaveBeenCalledTimes(2);
  expect(onTaskError).toHaveBeenNthCalledWith(1, firstErr, 0);
  expect(onTaskError).toHaveBeenNthCalledWith(2, secondErr, 2);
});

it("rejects early and stops scheduling new work in stop mode", async () => {
  const err = new Error("boom");
  const first = heldTask(10);
  const fail = vi.fn(failTask(err));
  const queued = vi.fn(async () => 30);
  const run = runTasksWithConcurrency({
    tasks: [first.run, fail, queued],
    limit: 2,
    errorMode: "stop",
    throwOnError: true,
  });

  await expect(run).rejects.toBe(err);
  first.release();
  await first.run.mock.results[0]!.value;
  await delay(0);
  expect([first.run, fail, queued].map((task) => task.mock.calls.length)).toEqual([1, 1, 0]);
  expect(first.run).toHaveBeenCalledBefore(fail);
});
