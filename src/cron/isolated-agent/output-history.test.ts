import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { buildOutputHistoryBlock, truncateOutputForHistory } from "./output-history.js";

function makeJob(overrides?: {
  outputHistory?: boolean;
  recentOutputs?: Array<{ text: string; timestamp: number }>;
  tz?: string;
}): CronJob {
  return {
    id: "job-1",
    name: "test-job",
    description: "",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    schedule: {
      kind: "cron",
      expr: "0 8 * * *",
      ...(overrides?.tz ? { tz: overrides.tz } : {}),
    },
    payload: {
      kind: "agentTurn",
      message: "test",
      ...(overrides?.outputHistory ? { outputHistory: true } : {}),
    },
    delivery: { mode: "none" },
    state: overrides?.recentOutputs ? { recentOutputs: overrides.recentOutputs } : {},
  } as CronJob;
}

describe("buildOutputHistoryBlock", () => {
  it("returns undefined when outputHistory is not enabled", () => {
    const job = makeJob({ recentOutputs: [{ text: "hello", timestamp: 1000 }] });
    expect(buildOutputHistoryBlock(job)).toBeUndefined();
  });

  it("returns undefined when outputHistory is enabled but no outputs exist", () => {
    const job = makeJob({ outputHistory: true });
    expect(buildOutputHistoryBlock(job)).toBeUndefined();
  });

  it("returns undefined when recentOutputs is empty array", () => {
    const job = makeJob({ outputHistory: true, recentOutputs: [] });
    expect(buildOutputHistoryBlock(job)).toBeUndefined();
  });

  it("returns undefined for non-agentTurn payload", () => {
    const job = makeJob({ outputHistory: true, recentOutputs: [{ text: "hi", timestamp: 1000 }] });
    (job.payload as { kind: string }).kind = "systemEvent";
    expect(buildOutputHistoryBlock(job)).toBeUndefined();
  });

  it("builds context block with formatted outputs", () => {
    const job = makeJob({
      outputHistory: true,
      recentOutputs: [
        { text: "First output", timestamp: 1710230400000 },
        { text: "Second output", timestamp: 1710316800000 },
      ],
    });
    const result = buildOutputHistoryBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("[Your previous outputs for this scheduled task");
    expect(result).toContain("First output");
    expect(result).toContain("Second output");
    const firstIdx = result!.indexOf("First output");
    const secondIdx = result!.indexOf("Second output");
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("uses job timezone for formatting when available", () => {
    const job = makeJob({
      outputHistory: true,
      tz: "Asia/Shanghai",
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    const result = buildOutputHistoryBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });

  it("falls back to default formatting for invalid timezone", () => {
    const job = makeJob({
      outputHistory: true,
      tz: "Invalid/Timezone",
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    const result = buildOutputHistoryBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });

  it("works with every-schedule jobs (no tz field)", () => {
    const job = makeJob({
      outputHistory: true,
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    job.schedule = { kind: "every", everyMs: 60_000 };
    const result = buildOutputHistoryBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });
});

describe("truncateOutputForHistory", () => {
  it("returns short text unchanged", () => {
    expect(truncateOutputForHistory("hello")).toBe("hello");
  });

  it("returns text at exactly the limit unchanged", () => {
    const text = "x".repeat(600);
    expect(truncateOutputForHistory(text)).toBe(text);
  });

  it("truncates long text keeping head and tail within limit", () => {
    const head = "H".repeat(400);
    const middle = "M".repeat(200);
    const tail = "T".repeat(400);
    const result = truncateOutputForHistory(`${head}${middle}${tail}`);
    expect(result).toContain("H".repeat(298));
    expect(result).toContain("T".repeat(298));
    expect(result).toContain("…");
    // partLen = floor((600 - 3) / 2) = 298; total = 298 + " … " + 298 = 599
    expect(result.length).toBeLessThanOrEqual(600);
  });

  it("does not expand text in the 601-602 char range", () => {
    const text = "A".repeat(601);
    const result = truncateOutputForHistory(text);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).toContain("…");
  });
});
