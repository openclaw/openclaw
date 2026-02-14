import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";

describe("session cost usage", () => {
  it("aggregates daily totals with log cost and pricing fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cost-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-1.jsonl");

    const now = new Date();
    const older = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    const entries = [
      {
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: { total: 0.03 },
          },
        },
      },
      {
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 20,
          },
        },
      },
      {
        type: "message",
        timestamp: older.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 5,
            output: 5,
            totalTokens: 10,
            cost: { total: 0.01 },
          },
        },
      },
    ];

    await fs.writeFile(
      sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf-8",
    );

    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.2",
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const originalState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const summary = await loadCostUsageSummary({ days: 30, config });
      expect(summary.daily.length).toBe(1);
      expect(summary.totals.totalTokens).toBe(50);
      expect(summary.totals.totalCost).toBeCloseTo(0.03003, 5);
    } finally {
      if (originalState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalState;
      }
    }
  });

  it("summarizes a single session file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cost-session-"));
    const sessionFile = path.join(root, "session.jsonl");
    const now = new Date();

    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 10,
            output: 20,
            totalTokens: 30,
            cost: { total: 0.03 },
          },
        },
      }),
      "utf-8",
    );

    const summary = await loadSessionCostSummary({
      sessionFile,
    });
    expect(summary?.totalCost).toBeCloseTo(0.03, 5);
    expect(summary?.totalTokens).toBe(30);
    expect(summary?.lastActivity).toBeGreaterThan(0);
  });

  it("captures message counts, tool usage, and model usage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cost-session-meta-"));
    const sessionFile = path.join(root, "session.jsonl");
    const start = new Date("2026-02-01T10:00:00.000Z");
    const end = new Date("2026-02-01T10:05:00.000Z");

    const entries = [
      {
        type: "message",
        timestamp: start.toISOString(),
        message: {
          role: "user",
          content: "Hello",
        },
      },
      {
        type: "message",
        timestamp: end.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          stopReason: "error",
          content: [
            { type: "text", text: "Checking" },
            { type: "tool_use", name: "weather" },
            { type: "tool_result", is_error: true },
          ],
          usage: {
            input: 12,
            output: 18,
            totalTokens: 30,
            cost: { total: 0.02 },
          },
        },
      },
    ];

    await fs.writeFile(
      sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf-8",
    );

    const summary = await loadSessionCostSummary({ sessionFile });
    expect(summary?.messageCounts).toEqual({
      total: 2,
      user: 1,
      assistant: 1,
      toolCalls: 1,
      toolResults: 1,
      errors: 2,
    });
    expect(summary?.toolUsage?.totalCalls).toBe(1);
    expect(summary?.toolUsage?.uniqueTools).toBe(1);
    expect(summary?.toolUsage?.tools[0]?.name).toBe("weather");
    expect(summary?.modelUsage?.[0]?.provider).toBe("openai");
    expect(summary?.modelUsage?.[0]?.model).toBe("gpt-5.2");
    expect(summary?.durationMs).toBe(5 * 60 * 1000);
    expect(summary?.latency?.count).toBe(1);
    expect(summary?.latency?.avgMs).toBe(5 * 60 * 1000);
    expect(summary?.latency?.p95Ms).toBe(5 * 60 * 1000);
    expect(summary?.dailyLatency?.[0]?.date).toBe("2026-02-01");
    expect(summary?.dailyLatency?.[0]?.count).toBe(1);
    expect(summary?.dailyModelUsage?.[0]?.date).toBe("2026-02-01");
    expect(summary?.dailyModelUsage?.[0]?.model).toBe("gpt-5.2");
  });

  it("does not exclude sessions with mtime after endMs during discovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discover-"));
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-late.jsonl");
    await fs.writeFile(sessionFile, "", "utf-8");

    const now = Date.now();
    await fs.utimes(sessionFile, now / 1000, now / 1000);

    const originalState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const sessions = await discoverAllSessions({
        startMs: now - 7 * 24 * 60 * 60 * 1000,
        endMs: now - 24 * 60 * 60 * 1000,
      });
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.sessionId).toBe("sess-late");
    } finally {
      if (originalState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalState;
      }
    }
  });

  it("resolves non-main absolute sessionFile using explicit agentId for cost summary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cost-agent-"));
    const workerSessionsDir = path.join(root, "agents", "worker1", "sessions");
    await fs.mkdir(workerSessionsDir, { recursive: true });
    const workerSessionFile = path.join(workerSessionsDir, "sess-worker-1.jsonl");
    const now = new Date("2026-02-12T10:00:00.000Z");

    await fs.writeFile(
      workerSessionFile,
      JSON.stringify({
        type: "message",
        timestamp: now.toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            input: 7,
            output: 11,
            totalTokens: 18,
            cost: { total: 0.01 },
          },
        },
      }),
      "utf-8",
    );

    const originalState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const summary = await loadSessionCostSummary({
        sessionId: "sess-worker-1",
        sessionEntry: { sessionFile: workerSessionFile } as { sessionFile: string },
        agentId: "worker1",
      });
      expect(summary?.totalTokens).toBe(18);
      expect(summary?.totalCost).toBeCloseTo(0.01, 5);
    } finally {
      if (originalState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalState;
      }
    }
  });

  it("resolves non-main absolute sessionFile using explicit agentId for timeseries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-timeseries-agent-"));
    const workerSessionsDir = path.join(root, "agents", "worker2", "sessions");
    await fs.mkdir(workerSessionsDir, { recursive: true });
    const workerSessionFile = path.join(workerSessionsDir, "sess-worker-2.jsonl");

    await fs.writeFile(
      workerSessionFile,
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-02-12T10:00:00.000Z",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.2",
            usage: { input: 5, output: 3, totalTokens: 8, cost: { total: 0.001 } },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const originalState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const timeseries = await loadSessionUsageTimeSeries({
        sessionId: "sess-worker-2",
        sessionEntry: { sessionFile: workerSessionFile } as { sessionFile: string },
        agentId: "worker2",
      });
      expect(timeseries?.points.length).toBe(1);
      expect(timeseries?.points[0]?.totalTokens).toBe(8);
    } finally {
      if (originalState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalState;
      }
    }
  });

  it("resolves non-main absolute sessionFile using explicit agentId for logs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-logs-agent-"));
    const workerSessionsDir = path.join(root, "agents", "worker3", "sessions");
    await fs.mkdir(workerSessionsDir, { recursive: true });
    const workerSessionFile = path.join(workerSessionsDir, "sess-worker-3.jsonl");

    await fs.writeFile(
      workerSessionFile,
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-02-12T10:00:00.000Z",
          message: {
            role: "user",
            content: "hello worker",
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const originalState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const logs = await loadSessionLogs({
        sessionId: "sess-worker-3",
        sessionEntry: { sessionFile: workerSessionFile } as { sessionFile: string },
        agentId: "worker3",
      });
      expect(logs).toHaveLength(1);
      expect(logs?.[0]?.content).toContain("hello worker");
      expect(logs?.[0]?.role).toBe("user");
    } finally {
      if (originalState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalState;
      }
    }
  });
});
