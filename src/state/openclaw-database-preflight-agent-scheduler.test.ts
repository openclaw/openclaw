import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqliteInspection from "../infra/sqlite-readonly-worker.js";
import { preflightAgentDatabasesBounded } from "./openclaw-database-preflight-agent-scheduler.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: vi.fn(() => 2),
}));

function fixture<T>(targets: readonly T[], timed = false) {
  if (timed) {
    vi.useFakeTimers();
  }
  const pending = targets.map(() => createDeferred());
  const tracked: Promise<unknown>[] = [];
  const started: T[] = [];
  const gateway = new AbortController();
  let settled = false;
  const result: OpenClawDatabaseSchemaPreflight = { incompatible: [], indeterminate: [] };
  const defer = vi.fn(
    (_inspections: { target: T; result: Promise<OpenClawDatabaseSchemaPreflight> }[]) => [],
  );
  const releaseAll = () => pending.forEach((release) => release.resolve());
  return {
    get settled() {
      return settled;
    },
    pending,
    tracked,
    started,
    gateway,
    result,
    defer,
    releaseAll,
    run(
      inspect: Parameters<typeof preflightAgentDatabasesBounded<T>>[1],
      canDefer?: (target: T) => boolean,
    ) {
      const run = preflightAgentDatabasesBounded(
        targets,
        (target, ...args) => {
          started.push(target);
          return inspect(target, ...args);
        },
        result,
        undefined,
        canDefer
          ? {
              signal: gateway.signal,
              canDefer,
              defer,
              track: (work) => tracked.push(work),
            }
          : undefined,
      ).then((stats) => {
        settled = true;
        return stats;
      });
      tracked.push(run);
      void run.catch(() => {});
      return run;
    },
    async [Symbol.asyncDispose]() {
      gateway.abort();
      releaseAll();
      await Promise.allSettled(tracked);
      if (timed) {
        vi.useRealTimers();
      }
    },
  };
}

it("shares one foreground wait across active and queued agent inspections", async () => {
  await using f = fixture([0, 1, 2, 3], true);
  void f.run(
    async (target, inspection) => {
      await f.pending[target]!.promise;
      inspection.indeterminate.push({
        kind: "agent",
        path: `agent-${target}`,
        reason: "fixture",
      });
    },
    () => true,
  );
  await vi.advanceTimersByTimeAsync(4_000);
  f.pending[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect({ started: f.started, settled: f.settled }).toEqual({
    started: [0, 1, 2],
    settled: false,
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.settled).toBe(true);
  expect(f.result.indeterminate.map((entry) => entry.path)).toEqual(["agent-0"]);
  expect(f.defer).toHaveBeenCalledOnce();
  const pending = f.defer.mock.calls[0]![0];
  expect(pending.map(({ target }) => target)).toEqual([1, 2, 3]);
  expect(f.started).toEqual([0, 1, 2]);
  f.releaseAll();
  await Promise.all(f.tracked);
  const completed = await Promise.all(pending.map((entry) => entry.result));
  expect(completed.flatMap((entry) => entry.indeterminate.map((row) => row.path))).toEqual([
    "agent-1",
    "agent-2",
    "agent-3",
  ]);
});

it("keeps unowned custom stores in strict foreground admission", async () => {
  await using f = fixture(["custom.sqlite"], true);
  const run = f.run(
    async () => await f.pending[0]!.promise,
    () => false,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.settled).toBe(false);
  expect(f.defer).not.toHaveBeenCalled();
  f.releaseAll();
  await run;
  expect(f.settled).toBe(true);
  expect(f.defer).not.toHaveBeenCalled();
});

it("keeps deferred inspections alive until the Gateway owner stops", async () => {
  await using f = fixture(["slow.sqlite"], true);
  let signal: AbortSignal | undefined;
  await sqliteInspection.withSqliteReadOnlyWorkerScope(async () => {
    const foreground = f.run(
      async () => {
        signal = sqliteInspection.resolveSqliteInspectionSignal();
        await f.pending[0]!.promise;
        signal?.throwIfAborted();
      },
      () => true,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await foreground;
  });
  expect(signal?.aborted).toBe(false);
  f.gateway.abort(new Error("Gateway stopped"));
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toBe(f.gateway.signal.reason);
});

it("rejects a deferred failure while a strict store still prevents handoff", async () => {
  await using f = fixture([0, 1, 2], true);
  const failure = new Error("unowned database inspection failed");
  f.defer.mockImplementation(() => {
    throw new Error("An unfinished healthy peer prevents background handoff");
  });
  const run = f.run(
    async (target) => {
      await f.pending[target]!.promise;
      if (target === 0) {
        throw failure;
      }
    },
    (target) => target !== 1,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  f.pending[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  f.pending[1]!.resolve();
  await expect(run).rejects.toBe(failure);
  expect(f.defer).not.toHaveBeenCalled();
  expect(f.started).toEqual([0, 1]);
});

it("bounds active inspections to the host's CPUs", async () => {
  await using f = fixture([0, 1, 2]);
  let active = 0;
  let peak = 0;
  const run = f.run(async (target) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await f.pending[target]!.promise;
    } finally {
      active -= 1;
    }
  });
  await Promise.resolve();
  expect({ started: f.started, active, peak }).toEqual({ started: [0, 1], active: 2, peak: 2 });
  f.pending[0]!.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect({ started: f.started, peak }).toEqual({ started: [0, 1, 2], peak: 2 });
  f.releaseAll();
  await run;
  expect({ active, peak }).toEqual({ active: 0, peak: 2 });
});

it("preserves input result order when inspections finish out of order", async () => {
  await using f = fixture([0, 1, 2]);
  const run = f.run(async (target, inspection) => {
    await f.pending[target]!.promise;
    inspection.indeterminate.push({
      kind: "agent",
      path: `agent-${target}`,
      reason: `result-${target}`,
    });
  });
  await Promise.resolve();
  f.pending[1]!.resolve();
  await Promise.resolve();
  await Promise.resolve();
  f.pending[2]!.resolve();
  f.pending[0]!.resolve();
  await run;
  expect(f.result.indeterminate.map((entry) => entry.path)).toEqual([
    "agent-0",
    "agent-1",
    "agent-2",
  ]);
});
