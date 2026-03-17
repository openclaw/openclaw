import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { usageCommand, type UsageCommandOptions } from "./usage.js";

describe("usageCommand", () => {
  const withStateDir = async <T>(stateDir: string, fn: () => Promise<T>): Promise<T> =>
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, fn);

  const makeRuntime = () => {
    const lines: string[] = [];
    return {
      runtime: {
        log: (...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        },
        error: (...args: unknown[]) => {
          lines.push(`ERROR: ${args.map(String).join(" ")}`);
        },
        exit: (_code: number) => {
          // noop
        },
      },
      lines,
    };
  };

  it("outputs JSON with no usage data for empty state directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    await fs.mkdir(path.join(root, "agents", "main", "sessions"), { recursive: true });

    const { runtime, lines } = makeRuntime();

    await withStateDir(root, () => usageCommand({ today: true, json: true }, runtime));

    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0] ?? "{}") as {
      window: string;
      summary: { totals: { totalTokens: number } };
    };
    expect(result.window).toBe("today");
    expect(result.summary.totals.totalTokens).toBe(0);
  });

  it("aggregates tokens for today's window", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const now = new Date();
    const sessionFile = path.join(sessionsDir, "sess-usage-1.jsonl");

    const entries = [
      {
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          usage: {
            input: 100,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.005, input: 0.0015, output: 0.003, cacheRead: 0, cacheWrite: 0 },
          },
        },
      },
      {
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          usage: {
            input: 50,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.0025, input: 0.00075, output: 0.0015, cacheRead: 0, cacheWrite: 0 },
          },
        },
      },
    ];

    await fs.writeFile(
      sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf-8",
    );

    const { runtime, lines } = makeRuntime();

    await withStateDir(root, () => usageCommand({ today: true, json: true }, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      window: string;
      summary: {
        totals: {
          input: number;
          output: number;
          totalTokens: number;
          totalCost: number;
        };
      };
    };

    expect(result.window).toBe("today");
    expect(result.summary.totals.input).toBe(150);
    expect(result.summary.totals.output).toBe(300);
    expect(result.summary.totals.totalTokens).toBe(450);
    expect(result.summary.totals.totalCost).toBeCloseTo(0.0075, 6);
  });

  it("filters to last-7-days window when --week is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const recentTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago, out of window

    const sessionFile = path.join(sessionsDir, "sess-usage-week.jsonl");

    const entries = [
      {
        type: "message",
        timestamp: recentTs.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-4o",
          usage: {
            input: 500,
            output: 250,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.02 },
          },
        },
      },
      {
        type: "message",
        timestamp: oldTs.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-4o",
          usage: {
            input: 1000,
            output: 500,
            cost: { total: 0.05 },
          },
        },
      },
    ];

    await fs.writeFile(
      sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf-8",
    );

    const { runtime, lines } = makeRuntime();

    await withStateDir(root, () => usageCommand({ week: true, json: true }, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      window: string;
      summary: { totals: { input: number; output: number; totalTokens: number } };
    };

    // Only the recent entry should be included
    expect(result.window).toBe("last 7 days");
    expect(result.summary.totals.input).toBe(500);
    expect(result.summary.totals.output).toBe(250);
    expect(result.summary.totals.totalTokens).toBe(750);
  });

  it("outputs text format with daily table", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const now = new Date();
    const sessionFile = path.join(sessionsDir, "sess-text-out.jsonl");

    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-opus-4-5",
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 200,
            cacheWrite: 0,
            cost: { total: 0.1 },
          },
        },
      }),
      "utf-8",
    );

    const { runtime, lines } = makeRuntime();

    await withStateDir(root, () => usageCommand({ today: true }, runtime));

    // Should have at least a header, a date row, a totals section
    const fullOutput = lines.join("\n");
    expect(fullOutput).toContain("Usage report");
    expect(fullOutput).toContain("Totals:");
    expect(fullOutput).toContain("tokens:");
    expect(fullOutput).toContain("cost:");
  });

  it("defaults to today window when no flag is provided", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    await fs.mkdir(path.join(root, "agents", "main", "sessions"), { recursive: true });

    const { runtime, lines } = makeRuntime();

    await withStateDir(root, () => usageCommand({ json: true }, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as { window: string };
    expect(result.window).toBe("today");
  });

  it("includes startDate and endDate in JSON output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    await fs.mkdir(path.join(root, "agents", "main", "sessions"), { recursive: true });

    const { runtime, lines } = makeRuntime();

    const beforeNow = new Date();

    await withStateDir(root, () => usageCommand({ today: true, json: true }, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      startDate: string;
      endDate: string;
    };

    // startDate must be today
    const todayStr = beforeNow.toLocaleDateString("en-CA");
    expect(result.startDate).toBe(todayStr);
    // endDate must also be today
    expect(result.endDate).toBe(todayStr);
  });

  it("includes by-source breakdown when --by-source is set and cron store is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    await fs.mkdir(path.join(root, "agents", "main", "sessions"), { recursive: true });

    const { runtime, lines } = makeRuntime();

    const opts: UsageCommandOptions = {
      today: true,
      bySource: true,
      json: true,
    };

    await withStateDir(root, () => usageCommand(opts, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      sourceBreakdown?: unknown[];
      cronBreakdown?: unknown[];
    };

    // Even when the cron store is absent, the fields should be present (empty arrays)
    expect(Array.isArray(result.sourceBreakdown)).toBe(true);
    expect(Array.isArray(result.cronBreakdown)).toBe(true);
  });

  it("--by-source breakdown includes both 'cron' and 'direct' entries that sum to total", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Write a session file so loadCostUsageSummary returns non-zero totals
    const now = new Date();
    const sessionFile = path.join(sessionsDir, "sess-by-source.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          usage: {
            input: 400,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.01, input: 0.006, output: 0.003, cacheRead: 0, cacheWrite: 0 },
          },
        },
      }),
      "utf-8",
    );

    const { runtime, lines } = makeRuntime();

    const opts: UsageCommandOptions = {
      today: true,
      bySource: true,
      json: true,
    };

    await withStateDir(root, () => usageCommand(opts, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      summary: { totals: { totalTokens: number; totalCost: number } };
      sourceBreakdown: Array<{ source: string; totalTokens: number; totalCost: number }>;
    };

    const { sourceBreakdown } = result;
    expect(Array.isArray(sourceBreakdown)).toBe(true);

    const cronEntry = sourceBreakdown.find((s) => s.source === "cron");
    const directEntry = sourceBreakdown.find((s) => s.source === "direct");

    // Both sources must be present
    expect(cronEntry).toBeDefined();
    expect(directEntry).toBeDefined();

    // The breakdown must sum to the total
    const totalFromBreakdown = (cronEntry?.totalTokens ?? 0) + (directEntry?.totalTokens ?? 0);
    expect(totalFromBreakdown).toBe(result.summary.totals.totalTokens);

    const costFromBreakdown = (cronEntry?.totalCost ?? 0) + (directEntry?.totalCost ?? 0);
    expect(costFromBreakdown).toBeCloseTo(result.summary.totals.totalCost, 6);

    // With no cron store, all tokens are "direct"
    expect(directEntry?.totalTokens).toBe(result.summary.totals.totalTokens);
    expect(cronEntry?.totalTokens).toBe(0);
  });

  it("--by-source 'direct' equals total minus cron tokens when cron run-log has entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session with 600 tokens total
    const now = new Date();
    const sessionFile = path.join(sessionsDir, "sess-cron-direct.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          usage: {
            input: 400,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.012 },
          },
        },
      }),
      "utf-8",
    );

    // Write a cron run-log with 300 tokens for job "daily-report"
    const cronRunsDir = path.join(root, "cron", "runs");
    await fs.mkdir(cronRunsDir, { recursive: true });
    const cronLogFile = path.join(cronRunsDir, "daily-report.jsonl");
    await fs.writeFile(
      cronLogFile,
      JSON.stringify({
        ts: now.getTime(),
        jobId: "daily-report",
        action: "finished",
        status: "ok",
        sessionKey: "agent:main:cron:daily-report",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          total_tokens: 300,
        },
      }),
      "utf-8",
    );

    const { runtime, lines } = makeRuntime();

    const opts: UsageCommandOptions = {
      today: true,
      bySource: true,
      json: true,
      config: { cron: { store: path.join(root, "cron", "jobs.json") } } as never,
    };

    await withStateDir(root, () => usageCommand(opts, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      summary: { totals: { totalTokens: number } };
      sourceBreakdown: Array<{ source: string; totalTokens: number; runs: number }>;
      cronBreakdown: Array<{ jobId: string; totalTokens: number; totalCost: number }>;
    };

    const cronEntry = result.sourceBreakdown.find((s) => s.source === "cron");
    const directEntry = result.sourceBreakdown.find((s) => s.source === "direct");

    expect(cronEntry).toBeDefined();
    expect(directEntry).toBeDefined();

    // cron should have 300 tokens, direct = 600 - 300 = 300
    expect(cronEntry?.totalTokens).toBe(300);
    expect(directEntry?.totalTokens).toBe(300);

    // cronBreakdown should accumulate totalCost per job (Issue 2)
    const jobRow = result.cronBreakdown.find((j) => j.jobId === "daily-report");
    expect(jobRow).toBeDefined();
    expect(typeof jobRow?.totalCost).toBe("number");
  });

  it("--agent filters cron breakdown to only that agent's run-log entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    await fs.mkdir(path.join(root, "agents", "bot1", "sessions"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", "bot2", "sessions"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", "main", "sessions"), { recursive: true });

    const now = new Date();
    const cronRunsDir = path.join(root, "cron", "runs");
    await fs.mkdir(cronRunsDir, { recursive: true });

    // Two cron entries: one for bot1, one for bot2
    const cronLogFile = path.join(cronRunsDir, "mixed-jobs.jsonl");
    await fs.writeFile(
      cronLogFile,
      [
        JSON.stringify({
          ts: now.getTime(),
          jobId: "mixed-jobs",
          action: "finished",
          status: "ok",
          sessionKey: "agent:bot1:cron:mixed-jobs",
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        }),
        JSON.stringify({
          ts: now.getTime(),
          jobId: "mixed-jobs",
          action: "finished",
          status: "ok",
          sessionKey: "agent:bot2:cron:mixed-jobs",
          usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
        }),
      ].join("\n"),
      "utf-8",
    );

    const { runtime, lines } = makeRuntime();

    const opts: UsageCommandOptions = {
      today: true,
      bySource: true,
      agent: "bot1",
      json: true,
      config: { cron: { store: path.join(root, "cron", "jobs.json") } } as never,
    };

    await withStateDir(root, () => usageCommand(opts, runtime));

    const result = JSON.parse(lines[0] ?? "{}") as {
      sourceBreakdown: Array<{ source: string; totalTokens: number }>;
      cronBreakdown: Array<{ jobId: string; totalTokens: number }>;
    };

    const cronEntry = result.sourceBreakdown.find((s) => s.source === "cron");

    // Only bot1's 150 tokens should appear, not bot2's 300
    expect(cronEntry?.totalTokens).toBe(150);

    const jobRow = result.cronBreakdown.find((j) => j.jobId === "mixed-jobs");
    expect(jobRow?.totalTokens).toBe(150);
  });
});
