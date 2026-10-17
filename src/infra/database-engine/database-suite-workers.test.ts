import "./database-suite-workers.test-support.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../../config/paths.js";
import { WorkerTaskPool } from "../worker-task-pool.js";
import { createDatabaseSuiteWorkerScope } from "./database-suite-workers.test-support.js";

const options = { workerUrl: new URL("./port-command.worker.ts", import.meta.url), maxWorkers: 1 };

it("preserves suite-level reuse when no per-case scope is selected", async () => {
  const first = new WorkerTaskPool(options);
  const second = new WorkerTaskPool(options);
  expect(second).toBe(first);
  await first.close();
  expect(first.isClosed).toBe(false);
});

it("retires a scoped real pool once and refuses later admissions", async () => {
  const scope = createDatabaseSuiteWorkerScope();
  const pool = await scope.run(async () => {
    const first = new WorkerTaskPool(options);
    expect(new WorkerTaskPool(options)).toBe(first);
    return first;
  });
  const retired = scope.close();
  expect(pool.isClosed).toBe(true);
  expect(scope.close()).toBe(retired);
  await retired;
  await expect(scope.run(async () => new WorkerTaskPool(options))).rejects.toThrow(
    "scope is closed",
  );
  await expect(pool.run(null, {})).rejects.toThrow("scope is closed");
});

it("joins the original body and real close before a successor can acquire its own pool", async ({
  signal,
}) => {
  const first = createDatabaseSuiteWorkerScope();
  const second = createDatabaseSuiteWorkerScope();
  const lifetime = createFixtureLifetime();
  const entered = createDeferred();
  const continueBody = createDeferred();
  const checkedLateAdmission = createDeferred();
  const finishBody = createDeferred();
  const finishClose = createDeferred();
  const originalClose = WorkerTaskPool.prototype.close;
  const close = vi.spyOn(WorkerTaskPool.prototype, "close").mockImplementation(function (
    this: WorkerTaskPool<unknown, unknown>,
    ...args
  ) {
    // The actual owner fences admission now; only its settlement is held.
    const retired = originalClose.apply(this, args);
    return retired.then(() => finishClose.promise);
  });
  let oldPool: WorkerTaskPool<unknown, unknown> | undefined;
  let successorPool: WorkerTaskPool<unknown, unknown> | undefined;
  const body = lifetime.run(() =>
    first.run(async () => {
      oldPool = new WorkerTaskPool(options);
      entered.resolve();
      await continueBody.promise;
      expect(() => new WorkerTaskPool(options)).toThrow("scope is closed");
      await expect(oldPool.run(null, {})).rejects.toThrow("scope is closed");
      checkedLateAdmission.resolve();
      await finishBody.promise;
    }),
  );
  let drained: Promise<void> | undefined;
  let successor: Promise<void> | undefined;
  try {
    await withinTest(entered.promise, signal);
    const closing = first.close();
    void lifetime.verifyCleanup(() => closing);
    drained = lifetime.cleanup();
    successor = drained.then(() =>
      second.run(async () => {
        successorPool = new WorkerTaskPool(options);
      }),
    );
    expect(oldPool?.isClosed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(first.close()).toBe(closing);
    finishClose.resolve();
    await closing;
    expect(successorPool).toBeUndefined();
    continueBody.resolve();
    await withinTest(checkedLateAdmission.promise, signal);
    expect(successorPool).toBeUndefined();
    finishBody.resolve();
    await body;
    await successor;
    expect(successorPool).not.toBe(oldPool);
    expect(successorPool?.isClosed).toBe(false);
  } finally {
    continueBody.resolve();
    finishBody.resolve();
    finishClose.resolve();
    await Promise.allSettled([body, drained, successor]);
    await first.close();
    await second.close();
    close.mockRestore();
  }
});

it("retains a failed real-close receipt without retrying or admitting a successor", async () => {
  const directories = createTempDirTracker();
  // The real pool is joined before injecting failure; keep its deliberately
  // retained claim separate from the runner's own resource namespace.
  const owner = createVitestResourceOwner(directories.make("database-suite-failed-close-"));
  const lifetime = createFixtureLifetime(owner.root);
  const scope = createDatabaseSuiteWorkerScope();
  const successor = vi.fn(async () => new WorkerTaskPool(options));
  const failure = new Error("fixture retirement failure");
  const originalClose = WorkerTaskPool.prototype.close;
  const close = vi.spyOn(WorkerTaskPool.prototype, "close").mockImplementation(async function (
    this: WorkerTaskPool<unknown, unknown>,
    ...args
  ) {
    await originalClose.apply(this, args);
    throw failure;
  });
  try {
    const pool = await lifetime.run(() => scope.run(async () => new WorkerTaskPool(options)));
    const retirement = scope.close();
    void lifetime.verifyCleanup(() => retirement);
    const drain = lifetime.cleanup();
    const admission = drain.then(successor);
    void admission.catch(() => {});
    expect(pool.isClosed).toBe(true);
    await expect(retirement).rejects.toMatchObject({ errors: [failure] });
    await expect(drain).rejects.toThrow("Fixture cleanup unverified");
    await expect(admission).rejects.toThrow("Fixture cleanup unverified");
    expect(successor).not.toHaveBeenCalled();
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    expect(scope.close()).toBe(retirement);
    await expect(scope.close()).rejects.toMatchObject({ errors: [failure] });
    await expect(scope.run(async () => new WorkerTaskPool(options))).rejects.toThrow(
      "scope is closed",
    );
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    directories.cleanup();
  }
});

describe("database fixture environment lifetime", () => {
  const directories = createTempDirTracker();
  let stateDir: string;
  beforeAll(() => {
    stateDir = directories.make("database-suite-env-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterAll(() => directories.cleanup());

  it("does not retain a beforeAll-only stub across the runner's environment reset", () => {
    expect(resolveStateDir()).not.toBe(stateDir);
  });

  describe("per-case authored environment", () => {
    beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", stateDir));
    it("selects the authored state root after the runner reset", () => {
      expect(resolveStateDir()).toBe(stateDir);
    });
  });
});
