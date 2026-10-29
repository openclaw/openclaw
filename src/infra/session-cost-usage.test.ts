import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import {
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
import type { CostBreakdown } from "./session-cost-usage.types.js";

const breakdown = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const zeroPricing = breakdown();
const flatPricing = breakdown(1, 2, 0.5);
type Pricing = ModelDefinitionConfig["cost"];
const tieredPricing: Pricing = {
  ...flatPricing,
  tieredPricing: [
    { ...flatPricing, range: [0, 1_000] },
    { ...breakdown(2, 4, 1), range: [1_000, 100_000] },
  ],
};

type PricingCase = [
  name: string,
  expectedCost: number | undefined,
  pricing?: Pricing,
  recordedCost?: CostBreakdown,
  expectedBreakdown?: ReturnType<typeof breakdown>,
  mode?: "top-level" | "unavailable",
];
const priorityParts = breakdown(0.004, 0.004, 0.0004);
const billedZero: CostBreakdown = { total: 0, totalOrigin: "provider-billed" };
const interimBill = { ...billedZero, total: 0.001 };
const priorityBill = { total: 0.0084, ...priorityParts };

const textBlock = (value: string) => ({ type: "text", text: value });
const logMessage = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  role,
  content,
  ...extra,
});
const tool = (type: string, name: string, id = name) => ({ type, name, id });

const defaultConfig: OpenClawConfig = {};

async function refreshSessionCostUsageForTest(sessionFile: string): Promise<void> {
  await refreshCostUsageCacheForAgent({
    config: defaultConfig,
    agentId: "main",
    sessionFiles: [sessionFile],
  });
}

function pricingConfig(provider: string, id: string, input: number | Pricing) {
  const cost = typeof input === "number" ? breakdown(input) : input;
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

const jsonLines = (...entries: unknown[]) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");
const writeEntries = (file: string, entries: unknown[], trailingNewline = false) =>
  fs.writeFile(file, jsonLines(...entries) + (trailingNewline ? "\n" : ""), "utf-8");
const toolUsage = (name: string, count: number) => ({
  totalCalls: count,
  uniqueTools: 1,
  tools: [{ name, count }],
});

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-cost-");
let root: string;
let sessionsDir: string;
beforeEach(async () => {
  root = tempDirs.make();
  sessionsDir = path.join(root, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const readSummary = (
  params: Omit<Parameters<typeof loadSessionCostSummary>[0], "config" | "agentId">,
) => loadSessionCostSummary({ config: defaultConfig, agentId: "main", ...params });
const readCached = (
  params: Omit<Parameters<typeof loadSessionCostSummariesFromCache>[0], "config" | "agentId">,
) => loadSessionCostSummariesFromCache({ config: defaultConfig, agentId: "main", ...params });
const readAggregate = (
  params: Omit<Parameters<typeof loadCostUsageSummary>[0], "config" | "agentId"> = {},
) => loadCostUsageSummary({ config: defaultConfig, agentId: "main", ...params });
const readCachedAggregate = (
  params: Omit<Parameters<typeof loadCostUsageSummaryFromCache>[0], "config" | "agentId">,
) => loadCostUsageSummaryFromCache({ config: defaultConfig, agentId: "main", ...params });
const readLogs = (sessionFile: string, limit?: number) =>
  loadSessionLogs({ agentId: "main", sessionFile, limit });
const assistant = (
  timestamp: string | undefined,
  usage: unknown,
  details: Record<string, unknown> = {},
) => transcriptEntry(timestamp, { role: "assistant", usage, ...details });
const user = (timestamp: string, content: string) =>
  transcriptEntry(timestamp, { role: "user", content });
const modelMessage = (
  timestamp: string | undefined,
  tokens: number,
  details: Record<string, unknown> = {},
) =>
  assistant(timestamp, billed(tokens, 0, tokens, tokens / 1000), {
    provider: "openai",
    model: "gpt-5.5",
    ...details,
  });

const writeTranscript = async (sessionId: string, entry: unknown, directory = sessionsDir) => {
  const file = path.join(directory, `${sessionId}.jsonl`);
  await writeEntries(file, [{ type: "session", version: 1, id: sessionId }, entry], true);
  return file;
};
const writeMessages = async (...entries: unknown[]) => {
  const file = path.join(root, "session.jsonl");
  await writeEntries(file, entries);
  return file;
};

it("counts only measured turns; a turn with unknown usage still counts as a message", async () => {
  const unknown = (timestamp: string, content: unknown[], counters: Record<string, number>) =>
    assistant(
      timestamp,
      { ...counters, cost: { total: 0.01 }, usageReport: { state: "unavailable" } },
      { provider: "openai", model: "gpt-5.5", content, stopReason: "error" },
    );
  const sessionFile = await writeMessages(
    modelMessage("2026-02-05T12:00:00.000Z", 10),
    // A request that failed before any output, and one interrupted after partial counters.
    unknown("2026-02-05T12:01:00.000Z", [], { input: 0, output: 0, totalTokens: 0 }),
    unknown("2026-02-05T12:02:00.000Z", [textBlock("partial")], { input: 500, totalTokens: 600 }),
  );
  const summary = await readSummary({ sessionFile });
  expect(summary).toMatchObject({
    totalTokens: 10,
    missingCostEntries: 0,
    messageCounts: { assistant: 3, errors: 2 },
  });
  expect(summary).not.toHaveProperty("usageReport");
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
        providers: pricingConfig(provider, model, inputPrice).models.providers,
      }),
      "utf8",
    );
    await writeEntries(
      path.join(agentSessionsDir, `${agentId}-session.jsonl`),
      [
        { type: "session", version: 1, id: `${agentId}-session` },
        ...inputs.map((input) =>
          assistant(now, { input, output: 0, totalTokens: input }, { provider, model }),
        ),
      ],
      true,
    );
  };

  await writeAgentUsage("main", 9, [250_000]);
  await writeAgentUsage("alpha", 1, [1_000_000, 500_000]);
  await writeAgentUsage("beta", 2, [1_000_000]);
  const config = pricingConfig(provider, model, 7);

  for (const [agentId, totalTokens, totalCost] of [
    ["alpha", 1_500_000, 1.5],
    ["beta", 1_000_000, 2],
    ["main", 250_000, 2.25],
  ] as const) {
    const summary = await loadCostUsageSummary({ agentId, config });
    expect(summary.totals).toMatchObject({
      totalTokens,
      totalCost: expect.closeTo(totalCost, 8),
    });
  }
});

it("excludes untimestamped entries from direct bounded session ranges", async () => {
  const assistantEntry = (timestamp: string | undefined, tokens: number, model = "gpt-5.5") =>
    modelMessage(timestamp, tokens, { model, content: [{ type: "tool_use", name: "weather" }] });
  const sessionFile = await writeMessages(
    assistantEntry(undefined, 1_000, "glm-5"),
    assistantEntry("2026-02-05T12:00:00.001Z", 10),
    user("2026-02-05T12:00:00.025Z", "hello"),
    assistantEntry("2026-02-05T12:00:00.050Z", 20),
  );

  const rangeEndMs = Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1;
  const ranged = await readSummary({
    sessionFile,
    startMs: Date.UTC(2026, 1, 5, 12, 0, 0, 30),
    endMs: rangeEndMs,
  });

  expect(ranged?.totalTokens).toBe(20);
  expect(ranged?.dailyBreakdown).toMatchObject([
    { date: "2026-02-05", tokens: 20, cost: 0.02, totalTokens: 20, totalCost: 0.02 },
  ]);
  expect(ranged?.modelUsage?.map((entry) => entry.model)).toEqual(["gpt-5.5"]);

  const upperBounded = await readSummary({ sessionFile, endMs: rangeEndMs });
  expect(upperBounded?.totalTokens).toBe(30);
  expect(upperBounded?.modelUsage?.some((entry) => entry.model === "glm-5")).toBe(false);

  const allRange = await readSummary({
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
    modelMessage(timestamp, totalTokens, {
      model: timestamp ? "gpt-5.5" : "glm-5",
      content: [1, 2].map((n) => ({
        type: "toolCall",
        id: `${timestamp ?? "untimed"}-${n}`,
        name: "read",
        arguments: {},
      })),
    });
  await writeEntries(
    sessionFile,
    [assistantEntry(undefined, 1_000), assistantEntry("2026-02-05T12:00:00.000Z", 20)],
    true,
  );

  const session = { sessionId: "sess-v8-upgrade", sessionFile };
  await refreshSessionCostUsageForTest(sessionFile);

  const writeLegacyRollup = () => writeLegacyUsageCostRollupForTest(sessionFile);
  const appendUsage = (timestamp: string) =>
    fs.appendFile(sessionFile, `${JSON.stringify(assistantEntry(timestamp, 5))}\n`, "utf-8");
  const rangeEndMs = Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1;
  const readRange = (startMs: number, includeUntimestamped = false) =>
    readCached({
      sessions: [session],
      startMs,
      endMs: rangeEndMs,
      includeUntimestamped,
      requestRefresh: false,
    });
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
    const result = await readRange(Date.UTC(2026, 1, 5));
    expect(result, label).toMatchObject({
      cacheStatus: { status: "fresh" },
      summaries: [
        {
          totalTokens,
          messageCounts: { toolCalls },
          dailyMessageCounts: [{ toolCalls }],
        },
      ],
    });
    expect(result.summaries[0]?.toolUsage, label).toEqual(toolUsage("read", toolCalls));
  }

  const allTime = await readRange(0, true);
  expect(allTime.summaries[0]).toMatchObject({
    totalTokens: 1_030,
    messageCounts: { toolCalls: 8 },
    dailyMessageCounts: [{ toolCalls: 6 }],
  });
  expect(allTime.summaries[0]?.toolUsage).toEqual(toolUsage("read", 8));
});

it("fills every calendar day across a spring-forward DST transition", async () => {
  const summary = await readAggregate({
    startMs: Date.UTC(2026, 2, 8, 6, 30),
    endMs: Date.UTC(2026, 2, 14, 5, 30),
    dayBucket: { mode: "time-zone", timeZone: "America/Denver" },
  });
  expect(summary.daily.map((d) => d.date)).toEqual(
    ["07", "08", "09", "10", "11", "12", "13"].map((day) => `2026-03-${day}`),
  );
  expect(summary.daily.every((d) => d.totalTokens === 0 && d.totalCost === 0)).toBe(true);
  expect(summary.totals.totalTokens).toBe(0);
});

it("limits transcript stat fanout when listing durable cost inputs", async () => {
  await Promise.all(
    Array.from({ length: 48 }, async (_, index) => {
      await fs.writeFile(path.join(sessionsDir, `sess-stat-fanout-${index}.jsonl`), "");
    }),
  );

  const originalStat = nodeFs.promises.stat.bind(nodeFs.promises);
  let activeStats = 0;
  let maxActiveStats = 0;
  vi.spyOn(nodeFs.promises, "stat").mockImplementation(async (target) => {
    const targetPath = String(target);
    if (targetPath.startsWith(sessionsDir) && targetPath.endsWith(".jsonl")) {
      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      try {
        await delay(2);
        return await originalStat(target);
      } finally {
        activeStats -= 1;
      }
    }
    return await originalStat(target);
  });

  const files = await listUsageCountedTranscriptStats("main", { sessionsDir });
  expect(files).toHaveLength(48);
  expect(new Set(files.map((file) => file.sessionId))).toEqual(
    new Set(Array.from({ length: 48 }, (_, index) => `sess-stat-fanout-${index}`)),
  );

  expect(maxActiveStats).toBeGreaterThan(1);
  expect(maxActiveStats).toBeLessThanOrEqual(32);
});

it("preserves rollups and aborts when the transcript directory cannot be read", async () => {
  await writeTranscript(
    "sess-readdir-error",
    assistant("2026-02-05T12:00:00.000Z", billed(4, 6, 10, 0.01)),
  );

  await readAggregate();
  const rowsBefore = readSessionCostUsageRollupRows("main");
  const movedSessionsDir = path.join(root, "saved-sessions");
  await fs.rename(sessionsDir, movedSessionsDir);
  try {
    await fs.writeFile(sessionsDir, "not a directory");
    await expect(readAggregate()).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally {
    await fs.rm(sessionsDir, { force: true });
    await fs.rename(movedSessionsDir, sessionsDir);
  }
  expect(readSessionCostUsageRollupRows("main")).toEqual(rowsBefore);
});

it("includes sessions outside the refreshed range in the first aggregate read", async () => {
  const timestamp = "2026-02-05T12:00:00.000Z";
  const oldSessionFile = await writeTranscript("cache-old", modelMessage(timestamp, 200));
  await writeTranscript("cache-current", modelMessage(timestamp, 30));
  const old = new Date("2025-12-05T12:00:00.000Z");
  await fs.utimes(oldSessionFile, old, old);

  await refreshCostUsageCacheForAgent({
    config: defaultConfig,
    agentId: "main",
    startMs: Date.UTC(2026, 1, 5),
  });
  const range = {
    startMs: Date.UTC(2026, 1, 5),
    endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
  };
  // The read refreshes the uncached session before it answers.
  expect((await readCachedAggregate(range)).totals.totalTokens).toBe(230);
});

it("waits for a busy refresh before loading a direct session summary", async () => {
  const sessionFile = await writeMessages(modelMessage("2026-02-01T10:00:00.000Z", 12));
  const lock = prepareSessionCostUsageRefreshLock("main");
  expect(await lock.acquire()).toBe(true);
  const released = delay(40).then(lock.release);
  try {
    expect((await readSummary({ sessionFile }))?.totalTokens).toBe(12);
  } finally {
    await released;
    await lock.release();
  }
});

it("captures message counts, tool usage, and model usage", async () => {
  const sessionFile = await writeMessages(
    user("2026-02-01T10:00:00.000Z", "Hello"),
    assistant("2026-02-01T10:05:00.000Z", billed(12, 18, 30, 0.02), {
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
    }),
  );

  const summary = await readSummary({ sessionFile });
  expect(summary?.messageCounts).toEqual({
    total: 2,
    user: 1,
    assistant: 1,
    toolCalls: 2,
    toolResults: 1,
    errors: 2,
  });
  expect(summary?.toolUsage).toEqual(toolUsage("weather", 2));
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
  const sessionFile = await writeTranscript(
    "cost-session-tool-result",
    transcriptEntry("2026-02-01T10:00:00.000Z", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "failed" }],
      isError: true,
    }),
    root,
  );

  const summary = await readSummary({ sessionFile });
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
  const startedAt = Date.UTC(2026, 1, 1, 12, 0, 5);
  const sessionFile = await writeTranscript(
    "cost-session-latency-append",
    user(new Date(startedAt).toISOString(), "go"),
    root,
  );

  const first = await readSummary({ sessionFile });
  expect(first?.latency).toBeUndefined();
  expect(readSessionCostUsageRollupRows()[0]?.valueJson).not.toContain('"min":null');

  await fs.appendFile(
    sessionFile,
    `${jsonLines(
      assistant(new Date(startedAt + 5_000).toISOString(), billed(1, 1, 2, 0.002), {
        content: "done",
      }),
    )}\n`,
  );
  const appended = await readSummary({ sessionFile });

  expect(appended?.latency).toMatchObject({ count: 1, minMs: 5_000, maxMs: 5_000 });
});

it("resolves the newest archive in the candidate session directory", async () => {
  for (const [suffix, text, tokens] of [
    ["reset.2026-02-12T11-00-00.000Z", "older reset archive", 10],
    ["deleted.2026-02-12T12-00-00.000Z", "newer deleted archive", 20],
  ] as const) {
    await writeEntries(path.join(root, `sess-mixed.jsonl.${suffix}`), [
      assistant("2026-02-12T12:00:00.000Z", billed(tokens, 0, tokens, tokens / 1000), {
        content: text,
      }),
    ]);
  }
  const lookup = {
    config: defaultConfig,
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
  const sessionFile = await writeMessages(
    user(
      "2026-02-21T17:47:00.000Z",
      [
        "    [message_id: literal]",
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
    ),
  );

  const logs = await readLogs(sessionFile);
  expect(logs).toMatchObject([{ role: "user", content: "[message_id: literal]\n\nhello there" }]);
});

it("does not split surrogate pairs when truncating session log content", async () => {
  const sessionFile = await writeMessages(
    transcriptEntry("2026-02-21T17:47:00.000Z", {
      role: "assistant",
      content: "x".repeat(1999) + "🚀tail",
    }),
  );
  expect((await readLogs(sessionFile))?.[0]?.content).toBe(`${"x".repeat(1999)}…`);
});

it("normalizes malformed log timestamps with the transcript timestamp rules", async () => {
  const sessionFile = await writeMessages(
    user("bad", "bad timestamp entry"),
    transcriptEntry("bad", {
      role: "assistant",
      content: "nested timestamp entry",
      timestamp: Date.parse("2026-02-21T17:46:00.000Z"),
    }),
    transcriptEntry("2026-02-21T17:47:00.000Z", {
      role: "assistant",
      content: "valid timestamp entry",
    }),
  );
  const logs = await readLogs(sessionFile);
  expect(logs?.map((log) => log.timestamp)).toEqual([
    0,
    Date.parse("2026-02-21T17:46:00.000Z"),
    Date.parse("2026-02-21T17:47:00.000Z"),
  ]);
});

it("aggregates exact UTC quarter-hour usage across midnight", async () => {
  const entries = [
    [
      "2026-03-15T06:30:00.000Z",
      {
        ...billed(5, 7, 25, 0.025),
        cache_read: 3,
        cache_creation_input_tokens: 2,
      },
    ],
    [
      "2026-03-15T06:35:00.000Z",
      {
        input: 1,
        output: 2,
        cache_read: 3,
        cache_creation_input_tokens: 4,
        cost: { total: 0.01 },
      },
    ],
    ["2026-03-15T23:59:00.000Z", billed(2, 3, 9, 0.009)],
    ["2026-03-16T00:00:00.000Z", billed(4, 5, 11, 0.011)],
  ] as const;
  const sessionFile = await writeMessages(
    ...entries.map(([timestamp, usage]) =>
      assistant(timestamp, usage, { provider: "openai", model: "gpt-5.2" }),
    ),
  );

  const summary = await readSummary({ sessionFile });
  const fields = [
    "date",
    "quarterIndex",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "totalCost",
  ] as const;
  const expected = [
    ["2026-03-15", 26, 6, 9, 6, 6, 35, expect.closeTo(0.035, 6)],
    ["2026-03-15", 95, 2, 3, 0, 0, 9, expect.closeTo(0.009, 6)],
    ["2026-03-16", 0, 4, 5, 0, 0, 11, 0.011],
  ];
  expect(summary?.utcQuarterHourTokenUsage).toEqual(
    expected.map((values) =>
      Object.fromEntries(fields.map((field, index) => [field, values[index]])),
    ),
  );
});

it("preserves sampled fields, stable ties, and cumulative values with fractional maxPoints", async () => {
  // Tied timestamps cross a sampled bucket boundary and retain transcript order.
  const entries = [8, 3, 1, 5, 2, 4, 10, 6, 9, 7].map((idx) =>
    assistant(new Date(Date.UTC(2026, 1, 12, 10, idx === 5 ? 4 : idx)).toISOString(), {
      input: idx,
      output: idx * 2,
      cacheRead: idx * 3,
      cacheWrite: idx * 4,
      totalTokens: idx * 11,
      cost: { total: idx * 0.001, totalOrigin: "provider-billed" },
    }),
  );
  const sessionFile = await writeMessages(...entries);

  const series = expectDefined(
    await loadSessionUsageTimeSeries({ agentId: "main", sessionFile, maxPoints: 2.5 }),
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
  const sessionFile = await writeMessages(
    assistant("2026-02-12T10:00:00Z", billed(1, 2, 3, 0.003)),
  );
  const stream = vi.spyOn(nodeFs, "createReadStream");
  for (const maxPoints of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      loadSessionUsageTimeSeries({ agentId: "main", sessionFile, maxPoints }),
    ).resolves.toEqual({ sessionId: undefined, points: [] });
  }
  expect(stream).not.toHaveBeenCalled();
});

it("returns empty logs for invalid limits", async () => {
  const sessionFile = await writeMessages(user("2026-02-12T10:00:00Z", "hello"));
  for (const limit of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(readLogs(sessionFile, limit)).resolves.toEqual([]);
  }
});

it("keeps the latest logs when transcript timestamps are out of order", async () => {
  const sessionFile = await writeMessages(
    ...(
      [
        ["2026-02-12T10:03:00.000Z", "third"],
        ["2026-02-12T10:01:00.000Z", "first"],
        ["2026-02-12T10:04:00.000Z", "fourth"],
        ["2026-02-12T10:02:00.000Z", "second"],
      ] as const
    ).map(([timestamp, content]) => user(timestamp, content)),
  );

  const logs = await readLogs(sessionFile, 2);

  expect(logs?.map((log) => log.content)).toEqual(["third", "fourth"]);
});
it.each<PricingCase>([
  ["top-level usage", 0.0021, flatPricing, undefined, breakdown(0.001, 0.001, 0.0001), "top-level"],
  ["unknown zero", undefined, undefined, { total: 0 }],
  ["zero pricing", 0, zeroPricing, { total: 0 }],
  ["interrupted placeholder", undefined, zeroPricing, { total: 0 }, undefined, "unavailable"],
  ["interrupted billing", undefined, undefined, interimBill, undefined, "unavailable"],
  // A later catalog cannot recover the recorded call's service tier.
  ["flat estimate survives tiers", 0.001, tieredPricing, { total: 0.001 }],
  ["priority estimate survives tiers", 0.0084, tieredPricing, priorityBill, priorityParts],
  ["tiered estimate", 0.0042, tieredPricing, undefined, breakdown(0.002, 0.002, 0.0002)],
  ["billed zero survives tiers", 0, tieredPricing, billedZero],
  ["zero with component evidence", 0, undefined, { total: 0, input: 0.25 }, breakdown(0.25)],
])(
  "keeps logs, summaries, and charts consistent for %s",
  async (_name, expectedCost, pricing, recordedCost, expectedBreakdown, mode) => {
    const usageUnavailable = mode === "unavailable";
    const topLevelUsage = mode === "top-level";
    const timestamp = Date.UTC(2026, 7, 1, 12);
    const usage = {
      ...breakdown(1_000, 500, 200),
      totalTokens: 1_700,
      ...(usageUnavailable ? { usageReport: { state: "unavailable" } } : {}),
      ...(recordedCost ? { cost: recordedCost } : {}),
    };
    const sessionFile = await writeMessages({
      provider: "reporting",
      model: "fixture-model",
      ...(topLevelUsage ? { usage } : {}),
      message: logMessage("assistant", "Answer", {
        timestamp,
        ...(topLevelUsage ? {} : { usage }),
      }),
    });
    const config = pricing ? pricingConfig("reporting", "fixture-model", pricing) : {};

    const params = { agentId: "main", sessionFile, config };
    const logs = await loadSessionLogs(params);
    expect(logs).toEqual([
      {
        ...logMessage("assistant", "Answer", { timestamp }),
        tokens: usageUnavailable ? undefined : 1_700,
        cost: expectedCost,
      },
    ]);

    const summary = await loadSessionCostSummary(params);
    // A turn with unknown usage adds no tokens, cost or missing-cost entry.
    expect(summary).toMatchObject({
      totalTokens: usageUnavailable ? 0 : 1_700,
      missingCostEntries: expectedCost === undefined && !usageUnavailable ? 1 : 0,
    });
    expect(summary?.totalCost).toBeCloseTo(expectedCost ?? 0, 8);
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      expect(summary?.[`${field}Cost`]).toBeCloseTo(expectedBreakdown?.[field] ?? 0, 8);
    }

    const series = await loadSessionUsageTimeSeries(params);
    expect(series?.points).toMatchObject(
      usageUnavailable ? [] : [{ totalTokens: 1_700, cost: expect.closeTo(expectedCost ?? 0, 8) }],
    );
  },
);

it("preserves canonical tool calls and mixed content order in session logs", async () => {
  const timestamp = Date.UTC(2026, 7, 1, 12);
  const messages = [
    logMessage("user", "Question"),
    logMessage("assistant", [tool("toolCall", "read", "call-only")]),
    logMessage("assistant", [tool(" toolUse ", " legacy-only ")]),
    logMessage("assistant", [
      textBlock("Before"),
      tool(" TOOL_CALL ", "read"),
      textBlock("Between"),
      tool("toolCall", "read"),
      tool("tool_use", " legacy "),
      tool("tooluse", "lowercase"),
      textBlock("After"),
    ]),
    logMessage("assistant", [textBlock("Ordinary answer")]),
    logMessage("toolResult", [textBlock("Done")], { toolCallId: "call-only", toolName: "read" }),
  ];
  const sessionFile = await writeMessages(
    ...messages.map((entry, index) =>
      transcriptEntry(new Date(timestamp + index).toISOString(), entry),
    ),
  );

  const logs = await loadSessionLogs({ agentId: "main", sessionFile, config: {} });
  expect(logs?.map(({ role, content }) => [role, content])).toEqual([
    ["user", "Question"],
    ["assistant", "[Tool: read]"],
    ["assistant", "[Tool:  legacy-only ]"],
    [
      "assistant",
      "Before\n[Tool: read]\nBetween\n[Tool: read]\n[Tool:  legacy ]\n[Tool: lowercase]\nAfter",
    ],
    ["assistant", "Ordinary answer"],
    ["toolResult", "[Tool: read]\n[Tool Result]\nDone"],
  ]);
});
