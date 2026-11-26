import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import * as terminalTable from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { HealthSummary } from "./health.js";
import { pluginHealthError } from "./health.test-fixtures.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import {
  baseStatusSession,
  createStatusCommandReportDataParams,
  createStatusHealth,
} from "./status.test-support.ts";

// mock-isolation: Formatting consumes fixed facts, not live backup or database inspection.
vi.mock("../state/backup-run-records.js", () => ({ readBackupRunFreshness: async () => ({}) }));
vi.mock("./status-database-engines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-database-engines.js")>()),
  resolveStatusDatabaseEngines: async () => ({ source: "admitted", stores: [] }),
}));

beforeEach(() => {
  for (const color of ["success", "warn", "muted", "error"] as const) {
    vi.spyOn(theme, color).mockImplementation(String);
  }
  vi.stubEnv("OPENCLAW_PROFILE", undefined);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
  vi.spyOn(terminalTable, "renderTable").mockReturnValue("table");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function report(overrides: Parameters<typeof createStatusCommandReportDataParams>[0]) {
  const lines = await buildStatusCommandReportLines(createStatusCommandReportDataParams(overrides));
  return lines.map(stripAnsi);
}

async function healthRows(health: Partial<HealthSummary>) {
  await report({ health: createStatusHealth(health) });
  return vi
    .mocked(terminalTable.renderTable)
    .mock.calls.find(([options]) => options.columns.some((column) => column.key === "Status"))?.[0]
    .rows;
}

it("prioritizes critical audit findings, caps warnings, and preserves remediation", async () => {
  const lines = await report({
    securityAudit: {
      ts: 1,
      summary: { critical: 1, warn: 6, info: 2 },
      findings: [
        ...Array.from({ length: 6 }, (_, index) => ({
          checkId: `warn-${index}`,
          severity: "warn" as const,
          title: `Warn ${index}`,
          detail: "warn detail",
        })),
        {
          checkId: "critical",
          severity: "critical",
          title: "Critical first",
          detail: "critical\ndetail",
          remediation: "fix it",
        },
      ],
    },
  });
  const start = lines.indexOf("Security audit") + 1;
  expect(lines.slice(start, start + 4)).toEqual([
    "Summary: 1 critical · 6 warn · 2 info",
    "  CRITICAL Critical first",
    "    critical detail",
    "    Fix: fix it",
  ]);
  expect(lines).toContain("… +1 more");
  expect(lines).not.toContain("  WARN Warn 5");
  expect(lines).toContain("Full report: openclaw security audit");
  expect(lines).toContain("Deep check: openclaw security audit --deep");
});

it("distinguishes pinned sessions from automatic fallbacks in a session report", async () => {
  const params = createStatusCommandReportDataParams();
  const lines = await report({
    summary: {
      ...params.summary,
      sessions: {
        ...params.summary.sessions,
        recent: [
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
        ],
      },
    },
  });
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

it("classifies a mixed channel report through the real health formatter", async () => {
  const account = {
    accountId: "default",
    configured: true,
    linked: true,
    healthState: "healthy",
  } satisfies HealthSummary["channels"][string];
  expect(
    await healthRows({
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

it("marks colon-bearing plugin failures as warnings", async () => {
  const rows = await healthRows({
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

it("shows blocked ingress even when the channel connection is healthy", async () => {
  const rows = await healthRows({
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

it("adds degraded event-loop health to status rows", async () => {
  expect(
    await healthRows({
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

it("warns when deep health says the retained Node executable is gone", async () => {
  const execPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";
  vi.spyOn(theme, "success").mockImplementation((value) => `ok(${String(value)})`);
  vi.spyOn(theme, "warn").mockImplementation((value) => `warn(${String(value)})`);
  const rows = await healthRows({ childRuntime: { execPath, available: false } });

  expect(rows?.[0]).toEqual({ Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" });
  expect(rows?.[1]).toEqual({
    Item: "Gateway runtime",
    Status: "warn(WARN)",
    Detail: `The Node.js runtime this Gateway started with (${execPath}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
  });
});
