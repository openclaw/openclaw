import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { printCronList } from "./shared.js";

describe("printCronList null guards", () => {
  it("does not throw when job.schedule is undefined", () => {
    const job = {
      id: "test-1",
      name: "broken-job",
      enabled: true,
      schedule: undefined,
      payload: { kind: "agentTurn" as const, message: "hi" },
      sessionTarget: "isolated",
      state: {},
    } as unknown as CronJob;

    const logs: string[] = [];
    const runtime = {
      log: (msg: string) => logs.push(msg),
      error: vi.fn(),
      exit: vi.fn(),
    };

    expect(() => printCronList([job], runtime as never)).not.toThrow();
  });

  it("does not throw when job.payload is undefined", () => {
    const job = {
      id: "test-2",
      name: "no-payload",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      payload: undefined,
      sessionTarget: "main",
      state: {},
    } as unknown as CronJob;

    const logs: string[] = [];
    const runtime = {
      log: (msg: string) => logs.push(msg),
      error: vi.fn(),
      exit: vi.fn(),
    };

    expect(() => printCronList([job], runtime as never)).not.toThrow();
  });
});
