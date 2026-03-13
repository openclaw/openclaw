// Authored by: cc (Claude Code) | 2026-03-13
import { describe, expect, it, vi } from "vitest";
import type { CronConfig } from "../config/types.cron.js";
import { loadHookEntries, runCronHooks } from "./hooks.js";
import type { CronHookContext } from "./hooks.js";
import type { CronJob } from "./types.js";

function stubJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    agentId: "test-agent",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  } as CronJob;
}

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeCtx(
  hookPoint: "beforeRun" | "afterComplete" | "onFailure" | "afterRun",
): CronHookContext {
  return {
    hookPoint,
    workflow: "cron",
    job: {
      id: "test-job",
      name: "Test Job",
      agentId: "test-agent",
      schedule: { kind: "every", everyMs: 60_000 },
    },
    meta: {},
    log: noopLog,
  };
}

describe("loadHookEntries", () => {
  it("returns empty when no hooks configured", () => {
    const entries = loadHookEntries("beforeRun", undefined, stubJob());
    expect(entries).toEqual([]);
  });

  it("returns empty when cronConfig has no hooks", () => {
    const config: CronConfig = { enabled: true };
    const entries = loadHookEntries("beforeRun", config, stubJob());
    expect(entries).toEqual([]);
  });

  it("loads global hook entries from cronConfig", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [{ script: "hooks/a.cjs", priority: 5 }, { script: "hooks/b.cjs" }],
      },
    };
    const entries = loadHookEntries("beforeRun", config, stubJob());
    expect(entries).toHaveLength(2);
    expect(entries[0].script).toBe("hooks/a.cjs");
    expect(entries[0].priority).toBe(5);
    expect(entries[1].script).toBe("hooks/b.cjs");
    expect(entries[1].priority).toBe(10);
  });

  it("loads per-job hook entries", () => {
    const job = stubJob({
      hooks: { afterComplete: ["hooks/job-hook.cjs"] },
    });
    const entries = loadHookEntries("afterComplete", undefined, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/job-hook.cjs");
    expect(entries[0].priority).toBe(10);
  });

  it("merges global and per-job entries sorted by priority", () => {
    const config: CronConfig = {
      hooks: {
        afterRun: [{ script: "hooks/global.cjs", priority: 20 }],
      },
    };
    const job = stubJob({
      hooks: { afterRun: ["hooks/job.cjs"] },
    });
    const entries = loadHookEntries("afterRun", config, job);
    expect(entries).toHaveLength(2);
    // Per-job default priority (10) < global priority (20), so job entry first.
    expect(entries[0].script).toBe("hooks/job.cjs");
    expect(entries[1].script).toBe("hooks/global.cjs");
  });

  it("skips global hooks when skipGlobal includes the hook point", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [{ script: "hooks/global.cjs" }],
      },
    };
    const job = stubJob({
      hooks: {
        beforeRun: ["hooks/job.cjs"],
        skipGlobal: ["beforeRun"],
      },
    });
    const entries = loadHookEntries("beforeRun", config, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/job.cjs");
  });

  it("filters by jobId", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [
          { script: "hooks/filtered.cjs", filter: { jobId: ["other-job"] } },
          { script: "hooks/match.cjs", filter: { jobId: ["test-job"] } },
        ],
      },
    };
    const entries = loadHookEntries("beforeRun", config, stubJob());
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/match.cjs");
  });

  it("filters by agentId", () => {
    const config: CronConfig = {
      hooks: {
        onFailure: [
          { script: "hooks/wrong-agent.cjs", filter: { agentId: ["other-agent"] } },
          { script: "hooks/right-agent.cjs", filter: { agentId: ["test-agent"] } },
        ],
      },
    };
    const entries = loadHookEntries("onFailure", config, stubJob());
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/right-agent.cjs");
  });
});

describe("runCronHooks", () => {
  it("returns not-aborted for empty entries", async () => {
    const result = await runCronHooks("beforeRun", makeCtx("beforeRun"), []);
    expect(result).toEqual({ aborted: false });
  });

  it("returns not-aborted for empty afterComplete entries", async () => {
    const result = await runCronHooks("afterComplete", makeCtx("afterComplete"), []);
    expect(result).toEqual({ aborted: false });
  });

  it("logs warning and continues when script module is not found", async () => {
    const ctx = makeCtx("afterRun");
    const entries = [{ script: "./nonexistent-hook-module-12345.cjs", priority: 10 }];
    const result = await runCronHooks("afterRun", ctx, entries);
    expect(result).toEqual({ aborted: false });
    expect(noopLog.warn).toHaveBeenCalled();
  });
});
