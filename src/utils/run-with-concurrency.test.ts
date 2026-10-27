import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest, withTestTimeout } from "../../test/helpers/promise.js";
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

it.each([
  [false, false],
  [true, false],
  [true, true],
])("isolates failures (%s, %s)", async (hookThrows, throwOnError) => {
  const scope = new AsyncLocalStorage<string>();
  async function runCaller(caller: string) {
    const taskError = new Error("task failed");
    const secondError = new Error("second failure");
    const hookError = new Error("error hook failed");
    const completed = createDeferred();
    const taskContext = `${caller}/task`;
    const contexts: Array<string | undefined> = [];
    const onTaskError = vi.fn(() => {
      contexts.push(scope.getStore());
      scope.enterWith(`${caller}/hook`);
      if (hookThrows) {
        throw hookError;
      }
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
          failTask(secondError),
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
      const result = await observed;
      expect(result).toMatchObject({ results: [undefined, undefined, 20], hasError: true });
      expect(result.firstError).toBe(taskError);
    }
    await wait(completed.promise);
    expect(contexts).toEqual([caller, taskContext, taskContext, caller, caller]);
    expect(onTaskError).toHaveBeenNthCalledWith(1, taskError, 0);
    expect(onTaskError).toHaveBeenNthCalledWith(2, secondError, 1);
  }
  try {
    await Promise.all([runCaller("first"), runCaller("second")]);
  } finally {
    scope.disable();
  }
});

it("preserves submitted factories and task order with bounded worker count", async ({ signal }) => {
  const jobs = [heldTask(1), heldTask(2), heldTask(3), heldTask(4)] as const;
  const [first, second, third, fourth] = jobs;
  const tasks = jobs.map((job) => job.run);
  const resultPromise = runTasksWithConcurrency({ tasks, limit: 2 });
  const resultSettled = Promise.allSettled([resultPromise]);
  try {
    await withinTest(wait(Promise.all([first.started, second.started])), signal);
    expect(jobs.map((job) => job.run.mock.calls.length)).toEqual([1, 1, 0, 0]);
    tasks[2] = vi.fn(async () => 30);
    tasks.push(vi.fn(async () => 50));
    second.release();
    await withinTest(wait(third.started), signal);
    expect(fourth.run).not.toHaveBeenCalled();
    first.release();
    await withinTest(wait(fourth.started), signal);
    third.release();
    fourth.release();
    const { hasError, firstError, results } = await withinTest(resultPromise, signal);
    expect([hasError, firstError, results]).toEqual([false, undefined, [1, 2, 3, 4]]);
  } finally {
    jobs.forEach((job) => job.release());
    await resultSettled;
    // An aggregate rejection can precede settlement of already-started tasks.
    await Promise.allSettled(jobs.flatMap((job) => job.run.mock.results.map(({ value }) => value)));
  }
});

it("rejects early and stops scheduling new work in stop mode", async ({ signal }) => {
  const err = new Error("boom");
  const first = heldTask(10);
  const fail = vi.fn(failTask(err));
  const queued = vi.fn(async () => 30);
  const tasks = [first.run, fail, queued];
  const run = runTasksWithConcurrency({
    tasks,
    limit: 2,
    errorMode: "stop",
    throwOnError: true,
  });

  const runSettled = Promise.allSettled([run]);
  try {
    await withinTest(expect(run).rejects.toBe(err), signal);
    first.release();
    await withinTest(first.run.mock.results[0]!.value, signal);
    await withinTest(delay(0), signal);
    expect(tasks.map((task) => task.mock.calls.length)).toEqual([1, 1, 0]);
    expect(first.run).toHaveBeenCalledBefore(fail);
  } finally {
    first.release();
    await runSettled;
    await Promise.allSettled(tasks.flatMap((task) => task.mock.results.map(({ value }) => value)));
  }
});
