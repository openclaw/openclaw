import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { HealthSummary } from "./health.js";
import {
  buildStatusHealthRows,
  buildStatusMemoryValue,
  buildStatusModelSelectionLines,
  buildStatusSecurityAuditLines,
} from "./status.command-sections.js";

const identity = String;
beforeEach(() => {
  vi.spyOn(theme, "success").mockImplementation(identity);
  vi.spyOn(theme, "warn").mockImplementation(identity);
  vi.spyOn(theme, "muted").mockImplementation(identity);
  vi.spyOn(theme, "error").mockImplementation(identity);
  vi.stubEnv("OPENCLAW_PROFILE", undefined);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("renders native provider health without legacy index counters", () => {
  const value = buildStatusMemoryValue({
    memory: {
      agentId: "main",
      provider: "records",
      health: { status: "degraded", message: "warming" },
    },
    memoryPlugin: { enabled: true, slot: "records" },
  });

  expect(value).toBe("plugin records · degraded · warming");
});

const baseHealth: HealthSummary = {
  ok: true,
  ts: 0,
  durationMs: 42,
  channels: {},
  channelOrder: [],
  channelLabels: {},
  heartbeatSeconds: 60,
  defaultAgentId: "main",
  agents: [],
  sessions: { path: "sessions", count: 0, recent: [] },
};
const session = {
  kind: "direct" as const,
  updatedAt: 1,
  age: 5000,
  model: null,
  totalTokens: null,
  totalTokensFresh: false,
  remainingTokens: null,
  percentUsed: null,
  contextTokens: null,
  flags: [],
};
const healthRows = (health: Partial<HealthSummary>) =>
  buildStatusHealthRows({
    health: { ...baseHealth, ...health },
  });

it("prioritizes critical audit findings, caps warnings, and preserves remediation", () => {
  const lines = buildStatusSecurityAuditLines({
    securityAudit: {
      summary: { critical: 1, warn: 6, info: 2 },
      findings: [
        ...Array.from({ length: 6 }, (_, index) => ({
          severity: "warn" as const,
          title: `Warn ${index}`,
          detail: "warn detail",
        })),
        {
          severity: "critical",
          title: "Critical first",
          detail: "critical\ndetail",
          remediation: "fix it",
        },
      ],
    },
  });
  expect(lines.slice(0, 4)).toEqual([
    "Summary: 1 critical · 6 warn · 2 info",
    "  CRITICAL Critical first",
    "    critical detail",
    "    Fix: fix it",
  ]);
  expect(lines).toContain("… +1 more");
  expect(lines).not.toContain("  WARN Warn 5");
  expect(lines.slice(-2)).toEqual([
    "Full report: openclaw security audit",
    "Deep check: openclaw security audit --deep",
  ]);
});

it("distinguishes pinned sessions from automatic fallbacks in a session report", () => {
  const lines = buildStatusModelSelectionLines({
    recent: [
      {
        ...session,
        key: "pinned",
        configuredModel: "zhipu/glm-4.5-air",
        selectedModel: "deepseek/deepseek-v4-flash",
        modelSelectionReason: "session override",
      },
      {
        ...session,
        key: "fallback",
        configuredModel: "minimax/MiniMax-M3",
        selectedModel: "ollama/qwen3.6-blue:35b-a3b",
        modelSelectionReason: "fallback selected",
      },
    ],
  });
  expect(lines).toContain(
    "Session pinned is pinned to deepseek/deepseek-v4-flash; config primary zhipu/glm-4.5-air will apply to new/unpinned sessions.",
  );
  expect(lines).toContain("  Configured default: zhipu/glm-4.5-air");
  expect(lines).toContain("  Session selected: deepseek/deepseek-v4-flash");
  expect(lines).toContain("  Reason: session override");
  expect(lines).toContain("  Clear with: /model default");
  expect(lines).toContain(
    "Session fallback is running ollama/qwen3.6-blue:35b-a3b (auto fallback); config primary is minimax/MiniMax-M3.",
  );
  expect(lines).toContain("  Reason: fallback selected");
  expect(lines).toContain("  Action: check provider availability or retry with /model");
});

it("classifies a mixed channel report through the real health formatter", () => {
  const account = {
    accountId: "default",
    configured: true,
    linked: true,
    healthState: "healthy",
  } satisfies HealthSummary["channels"][string];
  expect(
    healthRows({
      channels: {
        healthy: account,
        failed: { ...account, probe: { ok: false, error: "sync rejected" } },
        unknown: { ...account, healthState: "unknown" },
        unconfigured: { ...account, configured: false },
        disabled: { ...account, enabled: false, lastError: "previous start failed" },
        linked: { accountId: "default", linked: true },
        unlinked: { accountId: "default", linked: false },
        probed: {
          accountId: "default",
          probe: { ok: true, elapsedMs: 5, bot: { username: "testbot" } },
        },
      },
    }),
  ).toEqual([
    { Item: "Gateway", Status: "reachable", Detail: "42ms" },
    { Item: "healthy", Status: "OK", Detail: "healthy" },
    { Item: "failed", Status: "WARN", Detail: "failed (unknown) - sync rejected" },
    { Item: "unknown", Status: "WARN", Detail: "unknown" },
    { Item: "unconfigured", Status: "OFF", Detail: "not configured" },
    { Item: "disabled", Status: "OFF", Detail: "disabled (previous start failed)" },
    { Item: "linked", Status: "LINKED", Detail: "linked" },
    { Item: "unlinked", Status: "UNLINKED", Detail: "not linked" },
    { Item: "probed", Status: "OK", Detail: "ok (@testbot) (5ms)" },
  ]);
});

it("marks colon-bearing plugin failures as warnings", () => {
  const rows = healthRows({
    plugins: {
      loaded: ["broken:ok"],
      errors: [
        {
          id: "broken:ok",
          origin: "workspace",
          activated: true,
          failurePhase: "service",
          error: "service scheduler: address already in use",
        },
      ],
    },
  });
  expect(rows).toContainEqual({
    Item: "Plugin",
    Status: "WARN",
    Detail: "failed - broken:ok: service scheduler: address already in use; run openclaw doctor",
  });
});

it("shows blocked ingress even when the channel connection is healthy", () => {
  const rows = healthRows({
    channels: { Telegram: { accountId: "ops", healthState: "healthy" } },
    deliveryQueues: {
      failed: [],
      ingressPressure: [
        {
          channelId: "telegram",
          accountId: "ops",
          laneCount: 1,
          pendingCount: 2,
          claimedCount: 0,
          blockedCount: 1,
          oldestReceivedAt: Date.now(),
        },
      ],
    },
  });
  expect(rows).toContainEqual({ Item: "Telegram", Status: "OK", Detail: "healthy" });
  expect(rows).toContainEqual({
    Item: "Delivery queue",
    Status: "WARN",
    Detail: expect.stringContaining(
      "inbound telegram/ops: 1 pressured lane, 2 pending, 0 claimed, 1 blocked",
    ),
  });
});

it("adds degraded event-loop health to status rows", () => {
  expect(
    healthRows({
      eventLoop: {
        degraded: true,
        degradedSinceMs: 180_000,
        reasons: ["event_loop_delay"],
        intervalMs: 62_000,
        delayP99Ms: 61_000,
        delayMaxMs: 62_000,
        utilization: 1,
        cpuCoreRatio: 1,
      },
    }),
  ).toEqual([
    { Item: "Gateway", Status: "reachable", Detail: "42ms" },
    {
      Item: "Event loop",
      Status: "WARN",
      Detail:
        "degraded for 3m · reasons event_loop_delay · max 62000ms · p99 61000ms · util 1 · cpu 1",
    },
  ]);
});

it("warns when deep health says the retained Node executable is gone", () => {
  const execPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";
  vi.spyOn(theme, "success").mockImplementation((value) => `ok(${String(value)})`);
  vi.spyOn(theme, "warn").mockImplementation((value) => `warn(${String(value)})`);
  const rows = buildStatusHealthRows({
    health: {
      ...baseHealth,
      durationMs: 42,
      childRuntime: { execPath, available: false },
    },
  });

  expect(rows[0]).toEqual({ Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" });
  expect(rows[1]).toEqual({
    Item: "Gateway runtime",
    Status: "warn(WARN)",
    Detail: `Gateway runtime is stale after Node upgrade: child workers are using ${execPath}, which no longer exists. Restart the Gateway.`,
  });
});
