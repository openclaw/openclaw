import { describe, expect, it } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { printCronList } from "./shared.js";

function createRuntimeLogCapture(): { logs: string[]; runtime: RuntimeEnv } {
  const logs: string[] = [];
  const runtime = {
    log: (msg: string) => logs.push(msg),
    error: () => {},
    exit: () => {},
  } as RuntimeEnv;
  return { logs, runtime };
}

function createBaseJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-id",
    agentId: "main",
    name: "Test Job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3600000).toISOString() },
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: { nextRunAtMs: now + 3600000 },
    ...overrides,
  } as CronJob;
}

describe("printCronList", () => {
  it("handles job with undefined sessionTarget (#9649)", () => {
    const { logs, runtime } = createRuntimeLogCapture();

    // Simulate a job without sessionTarget (as reported in #9649)
    const jobWithUndefinedTarget = createBaseJob({
      id: "test-job-id",
      // sessionTarget is intentionally omitted to simulate the bug
    });

    // This should not throw "Cannot read properties of undefined (reading 'trim')"
    expect(() => printCronList([jobWithUndefinedTarget], runtime)).not.toThrow();

    // Verify output contains the job
    expect(logs.length).toBeGreaterThan(1);
    expect(logs.some((line) => line.includes("test-job-id"))).toBe(true);
  });

  it("handles job with defined sessionTarget", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const jobWithTarget = createBaseJob({
      id: "test-job-id-2",
      name: "Test Job 2",
      sessionTarget: "isolated",
    });

    expect(() => printCronList([jobWithTarget], runtime)).not.toThrow();
    expect(logs.some((line) => line.includes("isolated"))).toBe(true);
  });

  it("shows stagger label for cron schedules", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "staggered-job",
      name: "Staggered",
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 5 * 60_000 },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "tick" },
    });

    printCronList([job], runtime);
    expect(logs.some((line) => line.includes("(stagger 5m)"))).toBe(true);
  });

  it("shows exact label for cron schedules with stagger disabled", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "exact-job",
      name: "Exact",
      schedule: { kind: "cron", expr: "0 7 * * *", staggerMs: 0 },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "tick" },
    });

    printCronList([job], runtime);
    expect(logs.some((line) => line.includes("(exact)"))).toBe(true);
  });
});
