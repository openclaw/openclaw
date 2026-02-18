import { describe, expect, it } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { printCronList } from "./shared.js";

describe("printCronList", () => {
  it("handles job with undefined sessionTarget (#9649)", () => {
    const logs: string[] = [];
    const mockRuntime = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      exit: () => {},
    } as RuntimeEnv;

    // Simulate a job without sessionTarget (as reported in #9649)
    const jobWithUndefinedTarget = {
      id: "test-job-id",
      agentId: "main",
      name: "Test Job",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
      // sessionTarget is intentionally omitted to simulate the bug
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "test" },
      state: { nextRunAtMs: Date.now() + 3600000 },
    } as CronJob;

    // This should not throw "Cannot read properties of undefined (reading 'trim')"
    expect(() => printCronList([jobWithUndefinedTarget], mockRuntime)).not.toThrow();

    // Verify output contains the job
    expect(logs.length).toBeGreaterThan(1);
    expect(logs.some((line) => line.includes("test-job-id"))).toBe(true);
  });

  it("handles job with defined sessionTarget", () => {
    const logs: string[] = [];
    const mockRuntime = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      exit: () => {},
    } as RuntimeEnv;

    const jobWithTarget: CronJob = {
      id: "test-job-id-2",
      agentId: "main",
      name: "Test Job 2",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "test" },
      state: { nextRunAtMs: Date.now() + 3600000 },
    };

    expect(() => printCronList([jobWithTarget], mockRuntime)).not.toThrow();
    expect(logs.some((line) => line.includes("isolated"))).toBe(true);
  });

  it("shows stagger label for cron schedules", () => {
    const logs: string[] = [];
    const mockRuntime = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      exit: () => {},
    } as RuntimeEnv;

    const job: CronJob = {
      id: "staggered-job",
      name: "Staggered",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 5 * 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };

    printCronList([job], mockRuntime);
    expect(logs.some((line) => line.includes("(stagger 5m)"))).toBe(true);
  });

  it("shows exact label for cron schedules with stagger disabled", () => {
    const logs: string[] = [];
    const mockRuntime = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      exit: () => {},
    } as RuntimeEnv;

    const job: CronJob = {
      id: "exact-job",
      name: "Exact",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "0 7 * * *", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };

    printCronList([job], mockRuntime);
    expect(logs.some((line) => line.includes("(exact)"))).toBe(true);
  });
});
