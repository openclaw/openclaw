import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { buildDedupContextBlock } from "./dedup-context.js";

function makeJob(overrides?: {
  dedupContext?: boolean;
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
      ...(overrides?.dedupContext ? { dedupContext: true } : {}),
    },
    delivery: { mode: "none" },
    state: overrides?.recentOutputs ? { recentOutputs: overrides.recentOutputs } : {},
  } as CronJob;
}

describe("buildDedupContextBlock", () => {
  it("returns undefined when dedupContext is not enabled", () => {
    const job = makeJob({ recentOutputs: [{ text: "hello", timestamp: 1000 }] });
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("returns undefined when dedupContext is enabled but no outputs exist", () => {
    const job = makeJob({ dedupContext: true });
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("returns undefined when recentOutputs is empty array", () => {
    const job = makeJob({ dedupContext: true, recentOutputs: [] });
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("returns undefined for non-agentTurn payload", () => {
    const job = makeJob({ dedupContext: true, recentOutputs: [{ text: "hi", timestamp: 1000 }] });
    (job.payload as { kind: string }).kind = "systemEvent";
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("builds context block with formatted outputs", () => {
    const job = makeJob({
      dedupContext: true,
      recentOutputs: [
        { text: "First output", timestamp: 1710230400000 },
        { text: "Second output", timestamp: 1710316800000 },
      ],
    });
    const result = buildDedupContextBlock(job);
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
      dedupContext: true,
      tz: "Asia/Shanghai",
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    const result = buildDedupContextBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });

  it("works with every-schedule jobs (no tz field)", () => {
    const job = makeJob({
      dedupContext: true,
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    job.schedule = { kind: "every", everyMs: 60_000 };
    const result = buildDedupContextBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });
});
