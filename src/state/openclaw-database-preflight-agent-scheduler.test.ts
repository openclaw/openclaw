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
  it("keeps deferred inspections alive until the Gateway owner stops", async () => {
    vi.useFakeTimers();
    const budget = vi.spyOn(sqliteInspection, "readSqliteInspectionBudget").mockReturnValue({
      timeoutMs: 1,
      size: "fixture",
    });
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
            path: (pathname) => pathname,
            track: (work) => {
              tracked.push(work);
            },
            defer: () => [],
          },
        );
        await vi.advanceTimersByTimeAsync(1);
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
      budget.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects an expired inspection failure before background ownership is established", async () => {
    vi.useFakeTimers();
    const budget = vi
      .spyOn(sqliteInspection, "readSqliteInspectionBudget")
      .mockImplementation((_operation, pathname) => ({
        timeoutMs: pathname === "unowned.sqlite" ? 1 : 100,
        size: "fixture",
      }));
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
        path: (target) => (target === 0 ? "unowned.sqlite" : "healthy.sqlite"),
        track: () => {},
        defer,
      },
    );
    void run.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(1);
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
      budget.mockRestore();
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
