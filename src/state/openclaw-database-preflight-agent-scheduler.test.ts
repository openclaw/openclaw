import { availableParallelism } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqliteInspection from "../infra/sqlite-readonly-worker.js";
import { preflightAgentDatabasesBounded } from "./openclaw-database-preflight-agent-scheduler.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, availableParallelism: vi.fn(() => 2) };
});

function createResult(): OpenClawDatabaseSchemaPreflight {
  return {
    incompatible: [],
    indeterminate: [],
  };
}

describe("bounded agent database preflight scheduling", () => {
  it("shares one foreground wait across active and queued agent inspections", async () => {
    vi.useFakeTimers();
    const releases = [createDeferred(), createDeferred(), createDeferred(), createDeferred()];
    const tracked: Promise<unknown>[] = [];
    const started: number[] = [];
    const result = createResult();
    const defer = vi.fn(
      (_inspections: { target: number; result: Promise<OpenClawDatabaseSchemaPreflight> }[]) => [],
    );
    let foregroundSettled = false;
    const run = preflightAgentDatabasesBounded(
      [0, 1, 2, 3],
      async (target, inspection) => {
        started.push(target);
        await releases[target]!.promise;
        inspection.indeterminate.push({
          kind: "agent",
          path: `agent-${target}`,
          reason: "fixture",
        });
      },
      result,
      undefined,
      {
        signal: new AbortController().signal,
        canDefer: () => true,
        track: (work) => tracked.push(work),
        defer,
      },
    ).then(() => {
      foregroundSettled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      releases[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual([0, 1, 2]);
      expect(foregroundSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(foregroundSettled).toBe(true);
      expect(result.indeterminate.map((entry) => entry.path)).toEqual(["agent-0"]);
      expect(defer).toHaveBeenCalledOnce();
      const pending = defer.mock.calls[0]![0];
      expect(pending.map(({ target }) => target)).toEqual([1, 2, 3]);
      expect(started).toEqual([0, 1, 2]);

      for (const release of releases) {
        release.resolve();
      }
      await Promise.all(tracked);
      const completed = await Promise.all(pending.map((entry) => entry.result));
      expect(completed.flatMap((entry) => entry.indeterminate.map((row) => row.path))).toEqual([
        "agent-1",
        "agent-2",
        "agent-3",
      ]);
    } finally {
      for (const release of releases) {
        release.resolve();
      }
      await Promise.allSettled([run, ...tracked]);
      vi.useRealTimers();
    }
  });

  it("keeps unowned custom stores in strict foreground admission", async () => {
    vi.useFakeTimers();
    const released = createDeferred();
    const defer = vi.fn(() => []);
    let settled = false;
    const run = preflightAgentDatabasesBounded(
      ["custom.sqlite"],
      async () => await released.promise,
      createResult(),
      undefined,
      {
        signal: new AbortController().signal,
        canDefer: () => false,
        track: () => {},
        defer,
      },
    ).then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      expect(defer).not.toHaveBeenCalled();
      released.resolve();
      await run;
      expect(settled).toBe(true);
      expect(defer).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await run;
      vi.useRealTimers();
    }
  });

  it("keeps deferred inspections alive until the Gateway owner stops", async () => {
    vi.useFakeTimers();
    const gateway = new AbortController();
    const released = createDeferred();
    const tracked: Promise<unknown>[] = [];
    let inspectionSignal: AbortSignal | undefined;
    try {
      await sqliteInspection.withSqliteReadOnlyWorkerScope(async () => {
        const foreground = preflightAgentDatabasesBounded(
          ["slow.sqlite"],
          async () => {
            inspectionSignal = sqliteInspection.resolveSqliteInspectionSignal();
            await released.promise;
            inspectionSignal?.throwIfAborted();
          },
          createResult(),
          undefined,
          {
            signal: gateway.signal,
            canDefer: () => true,
            track: (work) => {
              tracked.push(work);
            },
            defer: () => [],
          },
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await foreground;
      });
      expect(inspectionSignal?.aborted).toBe(false);
      gateway.abort(new Error("Gateway stopped"));
      expect(inspectionSignal?.aborted).toBe(true);
      expect(inspectionSignal?.reason).toBe(gateway.signal.reason);
    } finally {
      gateway.abort();
      released.resolve();
      await Promise.allSettled(tracked);
      vi.useRealTimers();
    }
  });

  it("rejects a deferred failure while a strict store still prevents handoff", async () => {
    vi.useFakeTimers();
    const releases = [createDeferred(), createDeferred()];
    const failure = new Error("unowned database inspection failed");
    const started: number[] = [];
    const defer = vi.fn(() => {
      throw new Error("An unfinished healthy peer prevents background handoff");
    });
    const run = preflightAgentDatabasesBounded(
      [0, 1, 2],
      async (target) => {
        started.push(target);
        await releases[target]?.promise;
        if (target === 0) {
          throw failure;
        }
      },
      createResult(),
      undefined,
      {
        signal: new AbortController().signal,
        canDefer: (target) => target !== 1,
        track: () => {},
        defer,
      },
    );
    void run.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      releases[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      releases[1]!.resolve();
      await expect(run).rejects.toBe(failure);
      expect(defer).not.toHaveBeenCalled();
      expect(started).toEqual([0, 1]);
    } finally {
      for (const release of releases) {
        release.resolve();
      }
      await Promise.allSettled([run]);
      vi.useRealTimers();
    }
  });

  it.each([1, 2])("bounds active inspections to the host's %i CPUs", async (cpus) => {
    vi.mocked(availableParallelism).mockReturnValue(cpus);
    const releases = {
      0: createDeferred(),
      1: createDeferred(),
      2: createDeferred(),
    };
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const result = createResult();

    const run = preflightAgentDatabasesBounded(
      [0, 1, 2] as const,
      async (target) => {
        started.push(target);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await releases[target].promise;
        } finally {
          active -= 1;
        }
      },
      result,
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1].slice(0, cpus));
    expect(active).toBe(cpus);
    expect(peak).toBe(cpus);

    releases[0].resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([0, 1, 2].slice(0, cpus + 1));
    expect(peak).toBe(cpus);

    releases[1].resolve();
    releases[2].resolve();
    await run;

    expect(active).toBe(0);
    expect(peak).toBe(cpus);
    vi.mocked(availableParallelism).mockReturnValue(2);
  });

  it("preserves input result order when inspections finish out of order", async () => {
    const releases = {
      0: createDeferred(),
      1: createDeferred(),
      2: createDeferred(),
    };
    const result = createResult();

    const run = preflightAgentDatabasesBounded(
      [0, 1, 2] as const,
      async (target, inspection) => {
        await releases[target].promise;
        inspection.indeterminate.push({
          kind: "agent",
          path: `agent-${target}`,
          reason: `result-${target}`,
        });
      },
      result,
    );

    await Promise.resolve();

    releases[1].resolve();
    await Promise.resolve();
    await Promise.resolve();

    releases[2].resolve();
    releases[0].resolve();

    await run;

    expect(result.indeterminate.map((entry) => entry.path)).toEqual([
      "agent-0",
      "agent-1",
      "agent-2",
    ]);
  });
});
