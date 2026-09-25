// Cron service harness tests cover per-case SQLite and filesystem cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createCronStoreHarness,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { createCronRecoveryFixture } from "./service/run-recovery.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-harness-" });
let previousStorePath: string | undefined;

function testJob() {
  return {
    id: "job-1",
    name: "Test job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every" as const, everyMs: 60_000 },
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    payload: { kind: "systemEvent" as const, text: "tick" },
    state: {},
  };
}

describe("createCronStoreHarness", () => {
  it("tracks stores that callers do not explicitly clean", async () => {
    const store = await makeStorePath();
    previousStorePath = store.storePath;
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });
    expect((await loadCronStore(store.storePath)).jobs).toHaveLength(1);
  });

  it("clears tracked SQLite rows after each test", async () => {
    if (!previousStorePath) {
      throw new Error("expected previous test store path");
    }
    expect((await loadCronStore(previousStorePath)).jobs).toEqual([]);
  });

  it("supports explicit idempotent cleanup", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });

    await store.cleanup();
    await store.cleanup();

    expect((await loadCronStore(store.storePath)).jobs).toEqual([]);
  });
});

type Hook = () => void | Promise<void>;
type StoreFactory = Pick<
  ReturnType<ReturnType<typeof setupCronServiceSuite>["acquireFixture"]>,
  "makeStorePath"
>;

type Failure = { error: unknown };
let activeControl:
  | { finish: () => Promise<Failure | undefined>; markReported: () => void }
  | undefined;

async function withIsolatedHarness(
  body: (fixture: {
    suite: ReturnType<typeof setupCronServiceSuite>;
    hooks: Record<"beforeAll" | "beforeEach" | "afterEach" | "afterAll", Hook[]>;
    track: ReturnType<typeof createFixtureLifetime>["track"];
    release: (action: () => void) => void;
    afterJoin: Array<() => void>;
    assertCurrent: () => void;
    runHook: (hook: Hook) => Promise<void>;
    waitFor: <T>(ready: Promise<T>, original: Promise<unknown>) => Promise<T>;
    makeStore: (
      lease: StoreFactory,
    ) => Promise<{ storePath: string; cleanup: () => Promise<void> }>;
  }) => Promise<void>,
) {
  const outer = createFixtureLifetime();
  const controller = new AbortController();
  const { signal } = controller;
  const releases: Array<() => void> = [];
  let cleanup: Failure | undefined;
  let reported = false;
  let finishing: Promise<Failure | undefined> | undefined;
  const cancelled = createDeferred<never>();
  const cancelReadiness = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", cancelReadiness, { once: true });
  void cancelled.promise.catch(() => {});
  const unblock = (action: () => void) => {
    try {
      action();
    } catch (error) {
      outer.verifyCleanup(async () => {
        throw error;
      });
    }
  };
  const finish = () =>
    (finishing ??= (async () => {
      controller.abort(new Error("Cron harness control retired"));
      for (const action of releases.splice(0)) unblock(action);
      try {
        await outer.cleanup();
      } catch (error) {
        cleanup = { error };
      } finally {
        signal.removeEventListener("abort", cancelReadiness);
      }
      return cleanup;
    })());
  // A runner timeout does not unwind the body; its child hook joins this same drain.
  activeControl = {
    finish,
    markReported: () => {
      reported = true;
    },
  };
  onTestFinished(() => {
    if (cleanup && !reported) {
      reported = true;
      throw cleanup.error;
    }
  });
  const runHook = (hook: Hook) =>
    outer.track(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return hook();
      }),
    );
  let primary: Failure | undefined;
  try {
    await outer.run(async () => {
      signal.throwIfAborted();
      const root = outer.createTempDir("cron-harness-owner-control-");
      const hooks = {
        beforeAll: [] as Hook[],
        beforeEach: [] as Hook[],
        afterEach: [] as Hook[],
        afterAll: [] as Hook[],
      };
      const suite = setupCronServiceSuite({
        root,
        hooks: {
          beforeAll: (hook) => hooks.beforeAll.push(hook),
          beforeEach: (hook) => hooks.beforeEach.push(hook),
          afterEach: (hook) => hooks.afterEach.push(hook),
          afterAll: (hook) => hooks.afterAll.push(hook),
        },
      });
      const partitions: string[] = [];
      const afterJoin: Array<() => void> = [];
      await outer.acquire(async () => ({
        async cleanup() {
          for (const restore of afterJoin) restore();
          // Failed INNER receipts stay intact. This independent owner joins all
          // artificial work, clears its real SQL partitions, then removes scratch.
          for (const storePath of partitions)
            await saveCronStore(storePath, { version: 1, jobs: [] });
        },
      }));
      await runHook(hooks.beforeAll[0]!);
      signal.throwIfAborted();
      await body({
        suite,
        hooks,
        track: outer.track,
        release(action) {
          if (signal.aborted) unblock(action);
          else releases.push(action);
        },
        afterJoin,
        assertCurrent: () => signal.throwIfAborted(),
        runHook,
        async waitFor(ready, original) {
          signal.throwIfAborted();
          const value = await Promise.race([
            ready,
            original.then(() => {
              throw new Error("Expected a held allocation");
            }),
            cancelled.promise,
          ]);
          signal.throwIfAborted();
          return value;
        },
        async makeStore(lease) {
          signal.throwIfAborted();
          const store = await lease.makeStorePath();
          partitions.push(store.storePath);
          signal.throwIfAborted();
          await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });
          signal.throwIfAborted();
          return store;
        },
      });
    });
  } catch (error) {
    primary = { error };
  }
  const failure = await finish();
  if (failure) reported = true;
  if (primary && failure)
    throw new AggregateError([primary.error, failure.error], "Harness control and cleanup failed", {
      cause: primary.error,
    });
  if (primary) throw primary.error;
  if (failure) throw failure.error;
}

describe("cron fixture cleanup permission", () => {
  afterEach(async () => {
    const current = activeControl;
    activeControl = undefined;
    const failure = await current?.finish();
    if (current && failure) {
      current.markReported();
      throw failure.error;
    }
  });
  it.each([new Error("ordinary case failure"), undefined])(
    "preserves a joined case rejection while allowing safe parent cleanup (%s)",
    async (reason) => {
      await withIsolatedHarness(async ({ suite, hooks, track, afterJoin, makeStore, runHook }) => {
        const reports: Array<() => void> = [];
        const fixture = createCronRecoveryFixture(suite, (report) => reports.push(report));
        let storePath: string | undefined;
        const original = track(
          fixture.run(async (owner) => {
            ({ storePath } = await makeStore(owner));
            throw reason;
          }),
        );
        await expect(original).rejects.toBe(reason);
        if (!storePath) throw new Error("Expected the owned store before the case failed");
        await fixture.finishAfterEach();
        afterJoin.push(() => vi.useRealTimers());
        await runHook(hooks.beforeEach[0]!);
        for (const hook of hooks.afterEach.toReversed()) await runHook(hook);
        expect((await loadCronStore(storePath)).jobs).toEqual([]);
        expect(reports).toHaveLength(1);
        expect(reports[0]).not.toThrow();
      });
    },
  );

  it("requires both the original body and shutdown before store and root cleanup", async () => {
    await withIsolatedHarness(async ({ suite, hooks, track, release, makeStore, runHook }) => {
      const lease = suite.acquireFixture();
      const store = await makeStore(lease);
      const caseDir = path.dirname(path.dirname(store.storePath));
      const fixtureRoot = path.dirname(caseDir);
      const body = createDeferred();
      const shutdown = createDeferred();
      release(() => body.resolve());
      release(() => shutdown.resolve());
      const verified = track(
        lease.verifyQuiescence(async () => {
          await body.promise;
          await shutdown.promise;
        }),
      );
      await expect(store.cleanup()).rejects.toThrow("Unreleased Vitest resource claim");
      for (const hook of [...hooks.beforeEach, ...hooks.afterEach, ...hooks.afterAll]) {
        await expect(runHook(hook)).rejects.toThrow("Unreleased Vitest resource claim");
      }
      body.resolve();
      await nextTurn();
      await expect(store.cleanup()).rejects.toThrow("Unreleased Vitest resource claim");
      expect((await loadCronStore(store.storePath)).jobs.map((job) => job.id)).toEqual(["job-1"]);
      expect((await fs.stat(caseDir)).isDirectory()).toBe(true);
      expect((await fs.stat(fixtureRoot)).isDirectory()).toBe(true);
      shutdown.resolve();
      await verified;
      await store.cleanup();
      await runHook(hooks.afterAll[0]!);
      expect((await loadCronStore(store.storePath)).jobs).toEqual([]);
      await expect(fs.stat(fixtureRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each([new Error("fixture shutdown failed"), undefined])(
    "retains a rejected verification without retrying or resetting its receipt (%s)",
    async (reason) => {
      await withIsolatedHarness(
        async ({ suite, hooks, track, afterJoin, makeStore, runHook, assertCurrent }) => {
          const lease = suite.acquireFixture();
          const store = await makeStore(lease);
          const failed = track(
            lease.verifyQuiescence(async () => {
              throw reason;
            }),
          );
          await expect(failed).rejects.toBe(reason);
          const replacement = vi.fn(async () => {});
          expect(lease.verifyQuiescence(replacement)).toBe(failed);
          await expect(failed).rejects.toBe(reason);
          expect(replacement).not.toHaveBeenCalled();
          assertCurrent();
          const reset = [
            vi.spyOn(vi, "useFakeTimers"),
            vi.spyOn(vi, "clearAllTimers"),
            vi.spyOn(vi, "useRealTimers"),
            vi.spyOn(vi, "setSystemTime"),
          ];
          afterJoin.push(() => {
            for (const spy of reset) spy.mockRestore();
          });
          await expect(store.cleanup()).rejects.toThrow("Unreleased Vitest resource claim");
          for (const hook of [...hooks.beforeEach, ...hooks.afterEach, ...hooks.afterAll]) {
            await expect(runHook(hook)).rejects.toThrow("Unreleased Vitest resource claim");
          }
          for (const spy of reset) expect(spy).not.toHaveBeenCalled();
          expect(() => suite.acquireFixture()).toThrow("Unreleased Vitest resource claim");
          await expect(suite.makeStorePath()).rejects.toThrow("Unreleased Vitest resource claim");
          await expect(lease.makeStorePath()).rejects.toThrow("acquisition is closed");
          expect((await loadCronStore(store.storePath)).jobs.map((job) => job.id)).toEqual([
            "job-1",
          ]);
          expect((await fs.stat(path.dirname(path.dirname(store.storePath)))).isDirectory()).toBe(
            true,
          );
        },
      );
    },
  );

  it("admits the next fixture only after verified cleanup and keeps normal resets", async () => {
    await withIsolatedHarness(
      async ({ suite, hooks, afterJoin, makeStore, runHook, assertCurrent }) => {
        afterJoin.push(() => vi.useRealTimers());
        const first = suite.acquireFixture();
        const store = await makeStore(first);
        expect(() => suite.acquireFixture()).toThrow("Unreleased Vitest resource claim");
        await first.verifyQuiescence(async () => {});
        await runHook(hooks.beforeEach[0]!);
        for (const hook of hooks.afterEach.toReversed()) await runHook(hook);
        expect((await loadCronStore(store.storePath)).jobs).toEqual([]);
        assertCurrent();
        const next = suite.acquireFixture();
        await makeStore(next);
        await next.verifyQuiescence(async () => {});
      },
    );
  });

  it("rejects an allocation that resumes after its lease retires", async () => {
    await withIsolatedHarness(async ({ suite, track, release, afterJoin, waitFor }) => {
      const lease = suite.acquireFixture();
      const entered = createDeferred();
      const gate = createDeferred();
      release(() => gate.resolve());
      const mkdir = fs.mkdir;
      const held = vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
        const result = await mkdir(directory, options);
        entered.resolve();
        await gate.promise;
        return result;
      });
      afterJoin.push(() => held.mockRestore());
      const allocation = track(lease.makeStorePath());
      await waitFor(entered.promise, allocation);
      lease.closeAdmission();
      gate.resolve();
      await expect(allocation).rejects.toThrow("acquisition is closed");
      await lease.verifyQuiescence(async () => {
        await Promise.allSettled([allocation]);
      });
    });
  });
});
