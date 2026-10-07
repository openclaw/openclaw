import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelCostConfig } from "@openclaw/llm-core";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import * as usageFormat from "../utils/usage-format.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import {
  readSessionCostUsageRollupEntry,
  readSessionCostUsageRollupRows,
  writeLegacyUsageCostRollupForTest,
} from "./session-cost-usage-cache.test-support.js";
import { listUsageCountedTranscriptStats } from "./session-cost-usage-collection.test-support.js";
import {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummary,
  loadSessionCostSummariesFromCache,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";

async function refreshSessionCostUsageForTest(sessionFile: string): Promise<void> {
  await refreshCostUsageCacheForAgent({
    agentId: "main",
    sessionFiles: [sessionFile],
  });
}

function pricingConfig(provider: string, id: string, cost: ModelCostConfig) {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://pricing.invalid",
          models: [{ id, name: id, cost, reasoning: false, input: ["text"], maxTokens: 8192 }],
        },
      },
    },
  } satisfies OpenClawConfig;
}

const billed = (input: number, output: number, totalTokens: number, total: number) => ({
  input,
  output,
  totalTokens,
  cost: { total },
});

const transcriptEntry = (timestamp: string | undefined, message: Record<string, unknown>) => ({
  type: "message",
  timestamp,
  message,
});

async function writeEntries(file: string, entries: unknown[]): Promise<void> {
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf-8");
}

describe("session cost usage", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-cost-");
  let root: string;
  let sessionsDir: string;
  beforeEach(async () => {
    root = tempDirs.make();
    sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
  });
  afterEach(() => vi.unstubAllEnvs());
  const writeTranscript = (file: string, sessionId: string, entry: unknown) =>
    fs.writeFile(
      file,
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify(entry),
        "",
      ].join("\n"),
      "utf-8",
    );

  it("aggregates daily totals with log cost and pricing fallback", async () => {
    const sessionFile = path.join(sessionsDir, "sess-1.jsonl");

    const now = new Date();
    const older = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    const entries = [
      transcriptEntry(now.toISOString(), {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: { total: 0.03 },
        },
      }),
      transcriptEntry(now.toISOString(), {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
        },
      }),
      transcriptEntry(older.toISOString(), {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        usage: billed(5, 5, 10, 0.01),
      }),
    ];

    await writeEntries(sessionFile, entries);

    const config = pricingConfig("openai", "gpt-5.4", {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });

    const summary = await loadCostUsageSummary({ agentId: "main", config });

    expect(summary.daily.length).toBe(summary.days);
    const populated = summary.daily.filter((d) => d.totalTokens > 0);
    expect(populated).toHaveLength(1);
    expect(summary.totals.totalTokens).toBe(50);
    expect(summary.totals.totalCost).toBeCloseTo(0.03003, 5);
  });

  it("prices and aggregates usage with each row's agent-local registry", async () => {
    const provider = "demo-agent-scope";
    const model = "demo-model";
    const now = new Date().toISOString();
    const writeAgentUsage = async (agentId: string, inputPrice: number, inputs: number[]) => {
      const agentRoot = path.join(root, "agents", agentId);
      const agentDir = path.join(agentRoot, "agent");
      const agentSessionsDir = path.join(agentRoot, "sessions");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(agentSessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: pricingConfig(provider, model, {
            input: inputPrice,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }).models.providers,
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(agentSessionsDir, `${agentId}-session.jsonl`),
        [
          JSON.stringify({ type: "session", version: 1, id: `${agentId}-session` }),
          ...inputs.map((input) =>
            JSON.stringify(
              transcriptEntry(now, {
                role: "assistant",
                provider,
                model,
                usage: { input, output: 0, totalTokens: input },
              }),
            ),
          ),
          "",
        ].join("\n"),
        "utf8",
      );
    };

    await writeAgentUsage("main", 9, [250_000]);
    await writeAgentUsage("alpha", 1, [1_000_000, 500_000]);
    await writeAgentUsage("beta", 2, [1_000_000]);
    const config = pricingConfig(provider, model, {
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });

    const alpha = await loadCostUsageSummary({ agentId: "alpha", config });
    const beta = await loadCostUsageSummary({ agentId: "beta", config });
    const unscoped = await loadCostUsageSummary({ agentId: "main", config });

    expect(alpha.totals.totalTokens).toBe(1_500_000);
    expect(alpha.totals.totalCost).toBeCloseTo(1.5, 8);
    expect(beta.totals.totalTokens).toBe(1_000_000);
    expect(beta.totals.totalCost).toBeCloseTo(2, 8);
    expect(alpha.totals.totalCost + beta.totals.totalCost).toBeCloseTo(3.5, 8);
    expect(unscoped.totals.totalTokens).toBe(250_000);
    expect(unscoped.totals.totalCost).toBeCloseTo(2.25, 8);
  });

  it("keeps rollup rows bounded with a multi-megabyte hosted pricing catalog", async () => {
    const sessionFile = path.join(sessionsDir, "large-pricing.jsonl");
    await writeEntries(sessionFile, [
      transcriptEntry("2026-07-28T12:00:00.000Z", {
        role: "assistant",
        provider: "openai",
        model: "catalog-model-0",
        usage: { input: 10, output: 20, totalTokens: 30 },
      }),
    ]);
    const pricing = Object.fromEntries(
      Array.from({ length: 40_000 }, (_, index) => [
        `openai/catalog-model-${index}`,
        { input: index + 1, output: index + 2, cacheRead: index + 3 },
      ]),
    );
    const bundleJson = JSON.stringify({
      schemaVersion: 1,
      generatedAt: 200,
      minVersion: "2026.7.0",
      sourceCommit: "large-rollup-pricing-test",
      providers: {
        openai: { models: [{ id: "catalog-model-0", cost: { input: 1, output: 2 } }] },
      },
      pricing,
    });
    expect(Buffer.byteLength(bundleJson)).toBeGreaterThan(2 * 1024 * 1024);
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: () => 100,
      readStoredCatalog: () => ({
        id: 1,
        source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
        bundle_json: bundleJson,
        generated_at: 200,
        min_version: "2026.7.0",
        etag: null,
        last_modified: null,
        checked_at: 200,
      }),
    });
    const config = pricingConfig("openai", "catalog-model-0", {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
    });

    try {
      const pricingFingerprint = usageFormat.resolveModelCostConfigFingerprint(config);
      expect(pricingFingerprint).toMatch(/^[0-9a-f]{64}$/u);

      await refreshCostUsageCacheForAgent({
        agentId: "main",
        config,
        sessionFiles: [sessionFile],
      });

      const row = readSessionCostUsageRollupRows("main").find(
        (candidate) => candidate.key === sessionFile,
      );
      expect(Buffer.byteLength(row?.valueJson ?? "")).toBeLessThan(32 * 1024);
      expect(JSON.parse(row?.valueJson ?? "null")).toMatchObject({
        pricingFingerprint,
      });
    } finally {
      setRemoteModelCatalogOverlaySourcesForTest();
    }
  });

  it("breaks missing costs down by raw provider and model attribution", async () => {
    const sessionFile = path.join(sessionsDir, "sess-missing-by-model.jsonl");
    const timestamp = Date.now() - 1_000;
    const entries = [
      ["custom", "unpriced-a"],
      ["custom", "unpriced-a"],
      ["other", "unpriced-b"],
    ].map(([provider, model], index) =>
      transcriptEntry(new Date(timestamp + index).toISOString(), {
        role: "assistant",
        provider,
        model,
        usage: {
          input: 1,
          output: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    );
    await writeEntries(sessionFile, entries);

    const summary = await loadCostUsageSummary({ agentId: "main" });
    expect(summary.totals.missingCostEntries).toBe(3);
    expect(summary.totals.missingCostByModel).toEqual({
      "custom/unpriced-a": 2,
      "other/unpriced-b": 1,
    });

    const sessionSummary = await loadSessionCostSummary({ agentId: "main", sessionFile });
    expect(sessionSummary?.missingCostByModel).toEqual(summary.totals.missingCostByModel);
    expect(sessionSummary?.dailyBreakdown?.[0]?.missingCostByModel).toEqual(
      summary.totals.missingCostByModel,
    );
  });

  it("excludes untimestamped entries from direct bounded session ranges", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const assistantEntry = (
      timestamp: string | undefined,
      totalTokens: number,
      model = "gpt-5.5",
    ) =>
      transcriptEntry(timestamp, {
        role: "assistant",
        provider: "openai",
        model,
        content: [{ type: "tool_use", name: "weather" }],
        usage: billed(totalTokens, 0, totalTokens, totalTokens / 1000),
      });
    const userEntry = (timestamp: string) =>
      transcriptEntry(timestamp, { role: "user", content: "hello" });

    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify(assistantEntry(undefined, 1_000, "glm-5")),
        JSON.stringify(assistantEntry("2026-02-05T12:00:00.001Z", 10)),
        JSON.stringify(userEntry("2026-02-05T12:00:00.025Z")),
        JSON.stringify(assistantEntry("2026-02-05T12:00:00.050Z", 20)),
      ].join("\n"),
      "utf-8",
    );

    const rangeEndMs = Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1;
    const ranged = await loadSessionCostSummary({
      agentId: "main",
      sessionFile,
      startMs: Date.UTC(2026, 1, 5, 12, 0, 0, 30),
      endMs: rangeEndMs,
    });

    expect(ranged?.totalTokens).toBe(20);
    expect(ranged?.dailyBreakdown).toMatchObject([
      { date: "2026-02-05", tokens: 20, cost: 0.02, totalTokens: 20, totalCost: 0.02 },
    ]);
    expect(ranged?.modelUsage?.map((entry) => entry.model)).toEqual(["gpt-5.5"]);

    const upperBounded = await loadSessionCostSummary({
      agentId: "main",
      sessionFile,
      endMs: rangeEndMs,
    });
    expect(upperBounded?.totalTokens).toBe(30);
    expect(upperBounded?.modelUsage?.some((entry) => entry.model === "glm-5")).toBe(false);

    const allRange = await loadSessionCostSummary({
      agentId: "main",
      sessionFile,
      startMs: 0,
      endMs: rangeEndMs,
      includeUntimestamped: true,
    });
    expect(allRange?.totalTokens).toBe(1_030);
    expect(allRange?.modelUsage?.some((entry) => entry.model === "glm-5")).toBe(true);
    expect(allRange?.dailyModelUsage?.some((entry) => entry.model === "glm-5")).toBe(false);
  });

  it("rebuilds obsolete rollups and preserves tool occurrences and untimestamped usage on append", async () => {
    const sessionFile = path.join(sessionsDir, "sess-v8-upgrade.jsonl");
    const assistantEntry = (timestamp: string | undefined, totalTokens: number) =>
      transcriptEntry(timestamp, {
        role: "assistant",
        provider: "openai",
        model: timestamp ? "gpt-5.5" : "glm-5",
        content: [
          { type: "toolCall", id: `${timestamp ?? "untimed"}-1`, name: "read", arguments: {} },
          { type: "toolCall", id: `${timestamp ?? "untimed"}-2`, name: "read", arguments: {} },
        ],
        usage: billed(totalTokens, 0, totalTokens, totalTokens / 1000),
      });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify(assistantEntry(undefined, 1_000)),
        JSON.stringify(assistantEntry("2026-02-05T12:00:00.000Z", 20)),
        "",
      ].join("\n"),
      "utf-8",
    );

    const session = { sessionId: "sess-v8-upgrade", sessionFile };
    await refreshSessionCostUsageForTest(sessionFile);
    const current = await loadSessionCostSummariesFromCache({
      sessions: [session],
      agentId: "main",
      requestRefresh: false,
    });
    expect(current.cacheStatus.status).toBe("fresh");

    const writeLegacyRollup = () => writeLegacyUsageCostRollupForTest(sessionFile);
    const appendUsage = (timestamp: string) =>
      fs.appendFile(sessionFile, `${JSON.stringify(assistantEntry(timestamp, 5))}\n`, "utf-8");
    const rangeEndMs = Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1;
    for (const [label, prepare, totalTokens, toolCalls] of [
      ["obsolete without append", writeLegacyRollup, 20, 2],
      [
        "obsolete with append",
        async () => {
          await writeLegacyRollup();
          await appendUsage("2026-02-05T13:00:00.000Z");
        },
        25,
        4,
      ],
      ["current append", () => appendUsage("2026-02-05T14:00:00.000Z"), 30, 6],
    ] as const) {
      await prepare();
      await refreshSessionCostUsageForTest(sessionFile);
      const result = await loadSessionCostSummariesFromCache({
        sessions: [session],
        agentId: "main",
        startMs: Date.UTC(2026, 1, 5),
        endMs: rangeEndMs,
        requestRefresh: false,
      });
      expect(result.cacheStatus.status, label).toBe("fresh");
      expect(result.summaries[0]?.totalTokens, label).toBe(totalTokens);
      expect(result.summaries[0]?.messageCounts?.toolCalls, label).toBe(toolCalls);
      expect(result.summaries[0]?.dailyMessageCounts?.[0]?.toolCalls, label).toBe(toolCalls);
      expect(result.summaries[0]?.toolUsage, label).toEqual({
        totalCalls: toolCalls,
        uniqueTools: 1,
        tools: [{ name: "read", count: toolCalls }],
      });
    }

    const appendedRow = expectDefined(
      readSessionCostUsageRollupRows("main").find((row) => row.key === sessionFile),
      "expected appended usage rollup",
    );
    const appendedRollup = expectDefined(
      readSessionCostUsageRollupEntry(appendedRow, "main"),
      "decoded appended rollup",
    );
    expect(appendedRollup.rollup.untimestamped.totals.totalTokens).toBe(1_000);

    const allTime = await loadSessionCostSummariesFromCache({
      sessions: [session],
      agentId: "main",
      startMs: 0,
      endMs: rangeEndMs,
      includeUntimestamped: true,
      requestRefresh: false,
    });
    expect(allTime.summaries[0]?.totalTokens).toBe(1_030);
    expect(allTime.summaries[0]?.messageCounts?.toolCalls).toBe(8);
    expect(allTime.summaries[0]?.dailyMessageCounts?.[0]?.toolCalls).toBe(6);
    expect(allTime.summaries[0]?.toolUsage).toEqual({
      totalCalls: 8,
      uniqueTools: 1,
      tools: [{ name: "read", count: 8 }],
    });
  });

  it("buckets daily totals with the request timezone offset", async () => {
    await writeTranscript(
      path.join(sessionsDir, "sess-offset.jsonl"),
      "sess-offset",
      transcriptEntry("2026-02-12T00:30:00.000Z", {
        role: "assistant",
        usage: billed(10, 5, 15, 0.00001),
      }),
    );

    const startMs = Date.UTC(2026, 1, 11, 2);
    const endMs = Date.UTC(2026, 1, 12, 1, 59, 59, 999);
    const summary = await loadCostUsageSummary({
      agentId: "main",
      startMs,
      endMs,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: -120 },
    });

    expect(summary.daily.map((entry) => entry.date)).toEqual(["2026-02-11"]);
    expect(summary.daily[0]?.totalTokens).toBe(15);
    expect(summary.daily[0]?.totalCost).toBeCloseTo(0.00001, 8);
  });

  it("fills every calendar day across a spring-forward DST transition", async () => {
    const summary = await loadCostUsageSummary({
      agentId: "main",
      startMs: Date.UTC(2026, 2, 8, 6, 30),
      endMs: Date.UTC(2026, 2, 14, 5, 30),
      dayBucket: { mode: "time-zone", timeZone: "America/Denver" },
    });
    expect(summary.daily.map((d) => d.date)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
    ]);
    expect(summary.daily.every((d) => d.totalTokens === 0 && d.totalCost === 0)).toBe(true);
    expect(summary.totals.totalTokens).toBe(0);
  });

  it("limits transcript stat fanout when listing durable cost inputs", async () => {
    await Promise.all(
      Array.from({ length: 48 }, async (_, index) => {
        const sessionId = `sess-stat-fanout-${index}`;
        await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), "");
      }),
    );

    const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
    let activeStats = 0;
    let maxActiveStats = 0;
    const statSpy = vi.spyOn(nodeFs.promises, "stat").mockImplementation(async (target) => {
      const targetPath = String(target);
      if (targetPath.startsWith(sessionsDir) && targetPath.endsWith(".jsonl")) {
        activeStats += 1;
        maxActiveStats = Math.max(maxActiveStats, activeStats);
        try {
          await new Promise((resolve) => {
            setTimeout(resolve, 2);
          });
          return await originalStat(target);
        } finally {
          activeStats -= 1;
        }
      }
      return await originalStat(target);
    });

    try {
      const files = await listUsageCountedTranscriptStats("main", { sessionsDir });
      expect(files).toHaveLength(48);
      expect(new Set(files.map((file) => file.sessionId))).toEqual(
        new Set(Array.from({ length: 48 }, (_, index) => `sess-stat-fanout-${index}`)),
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(maxActiveStats).toBeGreaterThan(1);
    expect(maxActiveStats).toBeLessThanOrEqual(32);
  });

  it("preserves rollups and aborts when the transcript directory cannot be read", async () => {
    await writeTranscript(
      path.join(sessionsDir, "sess-readdir-error.jsonl"),
      "sess-readdir-error",
      transcriptEntry("2026-02-05T12:00:00.000Z", {
        role: "assistant",
        usage: billed(4, 6, 10, 0.01),
      }),
    );

    await loadCostUsageSummary({ agentId: "main" });
    const rowsBefore = readSessionCostUsageRollupRows("main");
    const movedSessionsDir = path.join(root, "saved-sessions");
    await fs.rename(sessionsDir, movedSessionsDir);
    try {
      await fs.writeFile(sessionsDir, "not a directory");
      await expect(loadCostUsageSummary({ agentId: "main" })).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    } finally {
      await fs.rm(sessionsDir, { force: true });
      await fs.rename(movedSessionsDir, sessionsDir);
    }
    expect(readSessionCostUsageRollupRows("main")).toEqual(rowsBefore);
  });

  it("refreshes the requested range before background aggregate catch-up", async () => {
    const oldSessionFile = path.join(sessionsDir, "sess-cache-cold-sync-old.jsonl");
    const currentSessionFile = path.join(sessionsDir, "sess-cache-cold-sync-current.jsonl");
    await writeTranscript(
      oldSessionFile,
      "sess-cache-cold-sync-old",
      transcriptEntry("2026-02-05T12:00:00.000Z", {
        role: "assistant",
        usage: billed(100, 100, 200, 0.2),
      }),
    );
    await writeTranscript(
      currentSessionFile,
      "sess-cache-cold-sync-current",
      transcriptEntry("2026-02-05T12:00:00.000Z", {
        role: "assistant",
        usage: billed(10, 20, 30, 0.03),
      }),
    );
    await fs.utimes(
      oldSessionFile,
      new Date("2025-12-05T12:00:00.000Z"),
      new Date("2025-12-05T12:00:00.000Z"),
    );

    await refreshCostUsageCacheForAgent({
      agentId: "main",
      startMs: Date.UTC(2026, 1, 5),
    });
    const summary = await loadCostUsageSummaryFromCache({
      agentId: "main",
      startMs: Date.UTC(2026, 1, 5),
      endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
    });

    expect(summary.totals.totalTokens).toBe(30);
    await vi.waitFor(
      async () => {
        const refreshed = await loadCostUsageSummaryFromCache({
          agentId: "main",
          startMs: Date.UTC(2026, 1, 5),
          endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
          requestRefresh: false,
        });
        expect(refreshed.totals.totalTokens).toBe(230);
      },
      { interval: 1, timeout: 2_000 },
    );
  });

  it("waits for a busy refresh before loading a direct session summary", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await writeTranscript(
      sessionFile,
      "cost-session-busy-refresh",
      transcriptEntry("2026-02-01T10:00:00.000Z", {
        role: "assistant",
        usage: billed(7, 5, 12, 0.012),
      }),
    );

    const lock = prepareSessionCostUsageRefreshLock("main");
    let released: Promise<void> | undefined;
    try {
      expect(await lock.acquire()).toBe(true);
      released = delay(40).then(lock.release);
      const [summary] = await Promise.all([
        loadSessionCostSummary({ agentId: "main", sessionFile }),
        released,
      ]);
      expect(summary?.totalTokens).toBe(12);
    } finally {
      await released;
      await lock.release();
    }
  });

  it("captures message counts, tool usage, and model usage", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const start = new Date("2026-02-01T10:00:00.000Z");
    const end = new Date("2026-02-01T10:05:00.000Z");

    const entries = [
      transcriptEntry(start.toISOString(), {
        role: "user",
        content: "Hello",
      }),
      transcriptEntry(end.toISOString(), {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.4",
        stopReason: "error",
        toolName: "weather",
        content: [
          { type: "text", text: "Checking" },
          { type: "toolCall", id: "weather-1", name: "weather", arguments: {} },
          { type: "toolCall", id: "weather-2", name: "weather", arguments: {} },
          { type: "tool_result", is_error: true },
        ],
        usage: billed(12, 18, 30, 0.02),
      }),
    ];

    await writeEntries(sessionFile, entries);

    const summary = await loadSessionCostSummary({ agentId: "main", sessionFile });
    expect(summary?.messageCounts).toEqual({
      total: 2,
      user: 1,
      assistant: 1,
      toolCalls: 2,
      toolResults: 1,
      errors: 2,
    });
    expect(summary?.toolUsage).toEqual({
      totalCalls: 2,
      uniqueTools: 1,
      tools: [{ name: "weather", count: 2 }],
    });
    expect(summary).toMatchObject({
      dailyMessageCounts: [{ toolCalls: 2 }],
      modelUsage: [{ provider: "openai", model: "gpt-5.4" }],
      durationMs: 300_000,
      latency: { count: 1, avgMs: 300_000, p95Ms: 300_000 },
      dailyLatency: [{ date: "2026-02-01", count: 1 }],
      dailyModelUsage: [{ date: "2026-02-01", model: "gpt-5.4" }],
      utcQuarterHourMessageCounts: [
        { date: "2026-02-01", quarterIndex: 40, total: 2, user: 1, assistant: 1, toolCalls: 2 },
      ],
    });
  });

  it("counts standalone tool-result messages without inflating message or tool-call totals", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await writeTranscript(
      sessionFile,
      "cost-session-tool-result",
      transcriptEntry("2026-02-01T10:00:00.000Z", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "failed" }],
        isError: true,
      }),
    );

    const summary = await loadSessionCostSummary({ agentId: "main", sessionFile });
    expect(summary?.messageCounts).toEqual({
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 1,
      errors: 1,
    });
    expect(summary?.toolUsage).toBeUndefined();
  });

  it("initializes persisted latency minima on the first appended assistant sample", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const startedAt = Date.UTC(2026, 1, 1, 12, 0, 5);
    await writeTranscript(
      sessionFile,
      "cost-session-latency-append",
      transcriptEntry(new Date(startedAt).toISOString(), { role: "user", content: "go" }),
    );

    const first = await loadSessionCostSummary({ agentId: "main", sessionFile });
    expect(first?.latency).toBeUndefined();
    expect(readSessionCostUsageRollupRows()[0]?.valueJson).not.toContain('"min":null');

    await fs.appendFile(
      sessionFile,
      `${JSON.stringify(
        transcriptEntry(new Date(startedAt + 5_000).toISOString(), {
          role: "assistant",
          content: "done",
          usage: billed(1, 1, 2, 0.002),
        }),
      )}\n`,
    );
    const appended = await loadSessionCostSummary({ agentId: "main", sessionFile });

    expect(appended?.latency?.count).toBe(1);
    expect(appended?.latency?.minMs).toBe(5_000);
    expect(appended?.latency?.maxMs).toBe(5_000);
  });

  it("resolves the newest archive in the candidate session directory", async () => {
    for (const [suffix, text, tokens] of [
      ["reset.2026-02-12T11-00-00.000Z", "older reset archive", 10],
      ["deleted.2026-02-12T12-00-00.000Z", "newer deleted archive", 20],
    ] as const) {
      await writeEntries(path.join(root, `sess-mixed.jsonl.${suffix}`), [
        transcriptEntry("2026-02-12T12:00:00.000Z", {
          role: "assistant",
          content: text,
          usage: billed(tokens, 0, tokens, tokens / 1000),
        }),
      ]);
    }
    const lookup = {
      agentId: "main",
      sessionId: "sess-mixed",
      sessionFile: path.join(root, "sess-mixed.jsonl"),
    };
    const summary = await loadSessionCostSummary(lookup);
    expect(summary?.totalTokens).toBe(20);
    expect(summary?.sessionFile).toContain(".jsonl.deleted.");
    expect((await loadSessionLogs(lookup))?.[0]?.content).toContain("newer deleted archive");
  });

  it("strips inbound and untrusted metadata blocks from session usage logs", async () => {
    const sessionFile = path.join(sessionsDir, "sess-sanitize.jsonl");

    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify(
          transcriptEntry("2026-02-21T17:47:00.000Z", {
            role: "user",
            content: [
              markInboundContextLabel("Conversation info:"),
              "```json",
              '{"message_id":"abc123"}',
              "```",
              "",
              "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
              "private runtime context",
              "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              "hello there",
              "[message_id: abc123]",
              "",
              markInboundContextLabel("Context:"),
              '<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
              "Source: Channel metadata",
              "---",
              "Channel metadata (guildchat)",
              "Sender labels:",
              "example",
              '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
            ].join("\n"),
          }),
        ),
      ].join("\n"),
      "utf-8",
    );

    const logs = await loadSessionLogs({ agentId: "main", sessionFile });
    expect(logs).toHaveLength(1);
    expect(logs?.[0]?.role).toBe("user");
    expect(logs?.[0]?.content).toBe("hello there");
  });

  it("preserves indented message-ID code in user usage logs", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    await writeEntries(sessionFile, [
      transcriptEntry("2026-02-21T17:47:00Z", {
        role: "user",
        content: "    [message_id: literal]",
      }),
    ]);
    const logs = await loadSessionLogs({ agentId: "main", sessionFile });
    expect(logs).toHaveLength(1);
    expect(logs?.[0]?.content).toBe("[message_id: literal]");
  });

  it("does not split surrogate pairs when truncating session log content", async () => {
    const sessionFile = path.join(sessionsDir, "session.jsonl");
    await writeEntries(sessionFile, [
      transcriptEntry("2026-02-21T17:47:00.000Z", {
        role: "assistant",
        content: "x".repeat(1999) + "🚀tail",
      }),
    ]);
    expect((await loadSessionLogs({ agentId: "main", sessionFile }))?.[0]?.content).toBe(
      `${"x".repeat(1999)}…`,
    );
  });

  it("normalizes malformed log timestamps with the transcript timestamp rules", async () => {
    const sessionFile = path.join(sessionsDir, "session.jsonl");
    await writeEntries(sessionFile, [
      transcriptEntry("bad", { role: "user", content: "bad timestamp entry" }),
      transcriptEntry("bad", {
        role: "assistant",
        content: "nested timestamp entry",
        timestamp: Date.parse("2026-02-21T17:46:00.000Z"),
      }),
      transcriptEntry("2026-02-21T17:47:00.000Z", {
        role: "assistant",
        content: "valid timestamp entry",
      }),
    ]);
    const logs = await loadSessionLogs({ agentId: "main", sessionFile });
    expect(logs?.map((log) => log.timestamp)).toEqual([
      0,
      Date.parse("2026-02-21T17:46:00.000Z"),
      Date.parse("2026-02-21T17:47:00.000Z"),
    ]);
  });

  it("aggregates exact UTC quarter-hour usage across midnight", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const entries = [
      transcriptEntry("2026-03-15T06:30:00.000Z", {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.2",
        usage: {
          input: 5,
          output: 7,
          cache_read: 3,
          cache_creation_input_tokens: 2,
          totalTokens: 25,
          cost: { total: 0.025 },
        },
      }),
      transcriptEntry("2026-03-15T06:35:00.000Z", {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.2",
        usage: {
          input: 1,
          output: 2,
          cache_read: 3,
          cache_creation_input_tokens: 4,
          cost: { total: 0.01 },
        },
      }),
      transcriptEntry("2026-03-15T23:59:00.000Z", {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.2",
        usage: billed(2, 3, 9, 0.009),
      }),
      transcriptEntry("2026-03-16T00:00:00.000Z", {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.2",
        usage: billed(4, 5, 11, 0.011),
      }),
    ];

    await writeEntries(sessionFile, entries);

    const summary = await loadSessionCostSummary({ agentId: "main", sessionFile });
    expect(summary?.utcQuarterHourTokenUsage).toEqual([
      {
        date: "2026-03-15",
        quarterIndex: 26,
        input: 6,
        output: 9,
        cacheRead: 6,
        cacheWrite: 6,
        totalTokens: 35,
        totalCost: expect.closeTo(0.035, 6),
      },
      {
        date: "2026-03-15",
        quarterIndex: 95,
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 9,
        totalCost: expect.closeTo(0.009, 6),
      },
      {
        date: "2026-03-16",
        quarterIndex: 0,
        input: 4,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        totalCost: 0.011,
      },
    ]);
  });

  it("preserves sampled fields, stable ties, and cumulative values with fractional maxPoints", async () => {
    const maxPoints = 2.5;
    const sessionFile = path.join(root, "session.jsonl");

    // Tied timestamps cross a sampled bucket boundary and retain transcript order.
    const entries = [8, 3, 1, 5, 2, 4, 10, 6, 9, 7].map((idx) =>
      transcriptEntry(new Date(Date.UTC(2026, 1, 12, 10, idx === 5 ? 4 : idx)).toISOString(), {
        role: "assistant",
        usage: {
          input: idx,
          output: idx * 2,
          cacheRead: idx * 3,
          cacheWrite: idx * 4,
          totalTokens: idx * 11,
          cost: { total: idx * 0.001, totalOrigin: "provider-billed" },
        },
      }),
    );
    await writeEntries(sessionFile, entries);

    const series = expectDefined(
      await loadSessionUsageTimeSeries({ agentId: "main", sessionFile, maxPoints }),
      "session usage timeseries missing",
    );

    const expected = [
      { weight: 11, cumulativeWeight: 11, minute: 4 },
      { weight: 25, cumulativeWeight: 36, minute: 8 },
      { weight: 19, cumulativeWeight: 55, minute: 10 },
    ];
    expect(series.points).toEqual(
      expected.map(({ weight, cumulativeWeight, minute }) => ({
        timestamp: Date.UTC(2026, 1, 12, 10, minute),
        input: weight,
        output: weight * 2,
        cacheRead: weight * 3,
        cacheWrite: weight * 4,
        totalTokens: weight * 11,
        cost: expect.closeTo(weight * 0.001, 12),
        cumulativeTokens: cumulativeWeight * 11,
        cumulativeCost: expect.closeTo(cumulativeWeight * 0.001, 12),
      })),
    );
  });

  it("returns empty points without reading for invalid maxPoints", async () => {
    const sessionFile = path.join(sessionsDir, "session.jsonl");
    await writeEntries(sessionFile, [
      transcriptEntry("2026-02-12T10:00:00Z", { role: "assistant", usage: billed(1, 2, 3, 0.003) }),
    ]);
    const stream = vi.spyOn(nodeFs, "createReadStream");
    try {
      for (const maxPoints of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          loadSessionUsageTimeSeries({ agentId: "main", sessionFile, maxPoints }),
        ).resolves.toEqual({ sessionId: undefined, points: [] });
      }
      expect(stream).not.toHaveBeenCalled();
    } finally {
      stream.mockRestore();
    }
  });

  it("returns empty logs for invalid limits", async () => {
    const sessionFile = path.join(sessionsDir, "session.jsonl");
    await writeEntries(sessionFile, [
      transcriptEntry("2026-02-12T10:00:00Z", { role: "user", content: "hello" }),
    ]);
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(loadSessionLogs({ agentId: "main", sessionFile, limit })).resolves.toEqual([]);
    }
  });

  it("keeps the latest logs when transcript timestamps are out of order", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const entries = [
      ["2026-02-12T10:03:00.000Z", "third"],
      ["2026-02-12T10:01:00.000Z", "first"],
      ["2026-02-12T10:04:00.000Z", "fourth"],
      ["2026-02-12T10:02:00.000Z", "second"],
    ].map(([timestamp, content]) => transcriptEntry(timestamp, { role: "user", content }));
    await writeEntries(sessionFile, entries);

    const logs = await loadSessionLogs({ agentId: "main", sessionFile, limit: 2 });

    expect(logs?.map((log) => log.content)).toEqual(["third", "fourth"]);
  });
});
