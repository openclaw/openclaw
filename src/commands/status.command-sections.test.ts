import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { HealthSummary } from "./health.js";
import { pluginHealthError } from "./health.test-fixtures.js";
import {
  buildStatusHealthRows,
  buildStatusHeartbeatValue,
  buildStatusMemoryValue,
  buildStatusModelSelectionLines,
  buildStatusSecurityAuditLines,
} from "./status.command-sections.js";
import { baseStatusSession, createStatusHealth } from "./status.test-support.ts";

beforeEach(() => {
  for (const color of ["success", "warn", "muted", "error"] as const) {
    vi.spyOn(theme, color).mockImplementation(String);
  }
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

const healthRows = (health: Partial<HealthSummary>) =>
  buildStatusHealthRows({ health: createStatusHealth(health) });

it("shows valid configuration examples when heartbeat is waiting for a delivery route", () => {
  const agent = {
    agentId: "main",
    enabled: true,
    every: "1m",
    everyMs: 60_000,
    waitingForRoute: true,
  };
  const value = buildStatusHeartbeatValue({
    summary: { heartbeat: { defaultAgentId: "main", agents: [agent] } },
  });
  expect(value).toContain("1m (main; waiting for delivery route");
  expect(value).toContain('commands.ownerAllowFrom=["telegram:123456789"]');
  expect(value).toContain('heartbeat.target="telegram"');
  expect(value).toContain('heartbeat.to="123456789"');
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
  const lines = buildStatusModelSelectionLines([
    {
      ...baseStatusSession,
      key: "pinned",
      configuredModel: "first/a",
      selectedModel: "second/b",
      modelSelectionReason: "session override",
    },
    {
      ...baseStatusSession,
      key: "fallback",
      configuredModel: "third/c",
      selectedModel: "fourth/d",
      modelSelectionReason: "fallback selected",
    },
  ]);
  expect(lines).toEqual(
    expect.arrayContaining([
      "Session pinned is pinned to second/b; config primary first/a will apply to new/unpinned sessions.",
      "  Configured default: first/a",
      "  Session selected: second/b",
      "  Reason: session override",
      "  Clear with: /model default",
      "Session fallback is running fourth/d (auto fallback); config primary is third/c.",
      "  Reason: fallback selected",
      "  Action: check provider availability or retry with /model",
    ]),
  );
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
        pluginHealthError("broken:ok", "service scheduler: address already in use", {
          activated: true,
          failurePhase: "service",
        }),
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
  const rows = healthRows({ childRuntime: { execPath, available: false } });

  expect(rows[0]).toEqual({ Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" });
  expect(rows[1]).toEqual({
    Item: "Gateway runtime",
    Status: "warn(WARN)",
    Detail: `The Node.js runtime this Gateway started with (${execPath}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
  });
});
