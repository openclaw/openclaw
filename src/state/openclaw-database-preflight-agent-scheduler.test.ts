import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as sqliteInspection from "../infra/sqlite-readonly-worker.js";
import { preflightAgentDatabasesBounded } from "./openclaw-database-preflight-agent-scheduler.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

function createResult(): OpenClawDatabaseSchemaPreflight {
  return {
    incompatible: [],
    indeterminate: [],
  };
}

describe("bounded agent database preflight scheduling", () => {
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

  it("runs at most two inspections concurrently", async () => {
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
    expect(started).toEqual([0, 1]);
    expect(active).toBe(2);
    expect(peak).toBe(2);

    releases[0].resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([0, 1, 2]);
    expect(peak).toBe(2);

    releases[1].resolve();
    releases[2].resolve();
    await run;

    expect(active).toBe(0);
    expect(peak).toBe(2);
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
