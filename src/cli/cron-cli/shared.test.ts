import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { parseDurationMs, printCronList } from "./shared.js";

// Minimal CronJob factory
function makeCronJob(overrides: Partial<CronJob> & Record<string, unknown> = {}): CronJob {
  return {
    id: "test-id-000",
    name: "test-job",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "prompt",
    payload: { prompt: "hello" },
    state: {},
    ...overrides,
  } as CronJob;
}

describe("printCronList", () => {
  const captureLog = () => {
    const lines: string[] = [];
    const runtime = {
      log: vi.fn((msg: string) => lines.push(msg)),
      error: vi.fn(),
    };
    return { lines, runtime };
  };

  it("prints 'No cron jobs.' for empty list", () => {
    const { runtime } = captureLog();
    printCronList([], runtime as never);
    expect(runtime.log).toHaveBeenCalledWith("No cron jobs.");
  });

  it("handles job with standard id property", () => {
    const { lines, runtime } = captureLog();
    const job = makeCronJob({ id: "abc-123" });
    printCronList([job], runtime as never);
    // Header + 1 job line
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("abc-123");
  });

  it("handles job with jobId instead of id (Gateway API variant)", () => {
    const { lines, runtime } = captureLog();
    // Simulate Gateway returning jobId instead of id
    const job = makeCronJob({ id: undefined as unknown as string, jobId: "gateway-456" } as never);
    printCronList([job], runtime as never);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("gateway-456");
  });

  it("prefers jobId over id when both are present", () => {
    const { lines, runtime } = captureLog();
    const job = makeCronJob({ id: "fallback-id", jobId: "preferred-jobid" } as never);
    printCronList([job], runtime as never);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("preferred-jobid");
    expect(lines[1]).not.toContain("fallback-id");
  });

  it("does not crash when both id and jobId are missing", () => {
    const { lines, runtime } = captureLog();
    const job = makeCronJob({ id: undefined as unknown as string });
    printCronList([job], runtime as never);
    // Should not throw and should still print a line
    expect(lines).toHaveLength(2);
  });

  it("prints multiple jobs", () => {
    const { lines, runtime } = captureLog();
    const jobs = [
      makeCronJob({ id: "job-1", name: "first" }),
      makeCronJob({ id: "job-2", name: "second" }),
    ];
    printCronList(jobs, runtime as never);
    // Header + 2 job lines
    expect(lines).toHaveLength(3);
  });
});

describe("parseDurationMs", () => {
  it.each([
    ["1s", 1000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    ["500ms", 500],
    ["1.5s", 1500],
  ])("parses %s → %d", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it("returns null for empty string", () => {
    expect(parseDurationMs("")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(parseDurationMs("abc")).toBeNull();
    expect(parseDurationMs("-5s")).toBeNull();
  });
});
