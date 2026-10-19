import os from "node:os";
import path from "node:path";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import type { HealthSummary } from "./health.js";
import { healthSummary } from "./health.test-fixtures.js";
import { buildStatusOverviewSurfaceRows } from "./status-all/format.js";
import type { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import type { buildStatusCommandReportLines } from "./status.command-report.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

type StatusCommandOverviewRowsParams = Parameters<typeof buildStatusCommandOverviewRows>[0];
type StatusCommandReportDataParams = Parameters<typeof buildStatusCommandReportLines>[0];

const STATUS_TEST_STATE_DIR = path.join(os.tmpdir(), `openclaw-status-test-${process.pid}-absent`);

export const baseStatusCfg = {
  update: { channel: "stable" },
  gateway: { bind: "loopback" },
} as const;

const baseStatusUpdate = {
  installKind: "git",
  git: {
    branch: "main",
    tag: "v1.2.3",
    upstream: "origin/main",
    behind: 2,
    ahead: 0,
    dirty: false,
    fetchOk: true,
  },
  registry: { latestVersion: "2026.4.10" },
} as never;

export const baseStatusExpectedUpdateChannelInfo = {
  channel: "stable",
  source: "config",
  label: "stable (config)",
} as const;

export const baseStatusExpectedUpdateChannelLabel = baseStatusExpectedUpdateChannelInfo.label;

export const baseStatusGatewaySnapshot = {
  gatewayMode: "remote",
  remoteUrlMissing: false,
  gatewayConnection: {
    url: "wss://gateway.example.com",
    urlSource: "config",
    message: "Gateway target: wss://gateway.example.com",
  },
  gatewayReachable: true,
  gatewayProbe: { connectLatencyMs: 42, error: null } as never,
  gatewayProbeAuth: { token: "tok" },
  gatewayProbeAuthWarning: "warn-text",
  gatewaySelf: { host: "gateway", version: "1.2.3" },
} as const;

const installedService = <T extends object>(label: string, extra: T) => ({
  label,
  installed: true,
  loadedText: "loaded",
  ...extra,
});

export const baseStatusServices = {
  gatewayService: installedService("LaunchAgent", {
    managedByOpenClaw: true,
    runtimeShort: "running",
  }),
  nodeService: installedService("node", { runtime: { status: "running", pid: 42 } }),
  nodeOnlyGateway: null,
};

export const baseStatusOverviewSurface = {
  cfg: baseStatusCfg,
  update: baseStatusUpdate,
  tailscaleMode: "serve",
  tailscaleDns: "box.tail.ts.net",
  tailscaleHttpsUrl: "https://box.tail.ts.net",
  ...baseStatusGatewaySnapshot,
  ...baseStatusServices,
} as unknown as StatusOverviewSurface;

export function getStatusOverviewRowValue(
  item: string,
  overrides: Partial<Parameters<typeof buildStatusOverviewSurfaceRows>[0]> = {},
): string | undefined {
  return buildStatusOverviewSurfaceRows({
    ...baseStatusOverviewSurface,
    agentsValue: "2 total",
    ...overrides,
  }).find((row) => row.Item === item)?.Value;
}

export const baseStatusSession = {
  key: "session-key",
  kind: "direct" as const,
  updatedAt: 1,
  age: 5_000,
  model: "gpt-5.5",
  configuredModel: "openai/gpt-5.5",
  selectedModel: "openai/gpt-5.5",
  modelSelectionReason: null,
  runtime: "OpenClaw Default",
  totalTokens: 12_000,
  totalTokensFresh: true,
  remainingTokens: 4_000,
  percentUsed: 75,
  contextTokens: 16_000,
  flags: [],
};

const baseStatusSummary = {
  heartbeat: {
    defaultAgentId: "main",
    agents: [{ agentId: "main", enabled: true, everyMs: 60_000, every: "1m" }],
  },
  channelSummary: [],
  queuedSystemEvents: ["one", "two"],
  sessions: {
    count: 2,
    paths: ["store.json"],
    defaults: { model: "gpt-5.5", contextTokens: 12_000 },
    recent: [baseStatusSession],
    byAgent: [],
  },
} as unknown as StatusSummary;

const baseStatusObservations = {
  summary: baseStatusSummary,
  agentStatus: {
    defaultId: "main",
    ownership: "sole" as const,
    selectionRequired: false,
    bootstrapPendingCount: 1,
    totalSessions: 2,
    agents: [{ id: "main", lastActiveAgeMs: 60_000 }] as AgentLocalStatus[],
  },
  memory: {
    agentId: "main",
    files: 1,
    chunks: 2,
    vector: {},
    fts: {},
    cache: {},
  } as unknown as MemoryStatusSnapshot,
  memoryPlugin: {
    enabled: true,
    slot: "memory",
  } as const satisfies MemoryPluginStatus,
  pluginCompatibility: [
    { pluginId: "a", severity: "warn", message: "legacy" },
  ] as PluginCompatibilityNotice[],
};

export function createStatusScanResultFixture(
  overrides: Partial<StatusScanResult> = {},
): StatusScanResult {
  return {
    env: { OPENCLAW_STATE_DIR: STATUS_TEST_STATE_DIR },
    cfg: baseStatusCfg,
    sourceConfig: baseStatusCfg,
    configDiagnostics: null,
    secretDiagnostics: [],
    osSummary: { platform: "linux", arch: "x64", release: "test", label: "linux (x64)" },
    tailscaleMode: "off",
    tailscaleDns: null,
    tailscaleHttpsUrl: null,
    update: baseStatusUpdate,
    ...baseStatusGatewaySnapshot,
    channelIssues: [],
    channels: { rows: [], details: [] },
    ...baseStatusObservations,
    ...overrides,
  };
}

function createStatusLastHeartbeat(): HeartbeatEventPayload {
  return { ts: Date.now() - 30_000, status: "ok-token", channel: "quietchat", accountId: "acct" };
}

export function createStatusHealth(overrides: Partial<HealthSummary> = {}): HealthSummary {
  return healthSummary({
    durationMs: 42,
    agents: [],
    sessions: {
      path: "store.json",
      count: 2,
      recent: [{ key: "session-key", updatedAt: 1, age: 5_000 }],
    },
    ...overrides,
  });
}

function createStatusCommandFields() {
  return {
    env: { OPENCLAW_STATE_DIR: STATUS_TEST_STATE_DIR },
    surface: baseStatusOverviewSurface,
    ...baseStatusObservations,
    health: createStatusHealth(),
    lastHeartbeat: createStatusLastHeartbeat(),
    updateValue: "available · custom update",
  };
}

export function createStatusCommandOverviewRowsParams(
  overrides: Partial<StatusCommandOverviewRowsParams> = {},
): StatusCommandOverviewRowsParams {
  return {
    ...createStatusCommandFields(),
    backupFreshness: {},
    opts: { deep: true },
    osLabel: "macOS",
    ...overrides,
  };
}

export function createStatusCommandReportDataParams(
  overrides: Partial<StatusCommandReportDataParams> = {},
): StatusCommandReportDataParams {
  return {
    ...createStatusCommandFields(),
    opts: { deep: true, verbose: true },
    osSummary: { label: "macOS" } as never,
    securityAudit: {
      ts: Date.now(),
      summary: { critical: 0, warn: 1, info: 0 },
      findings: [
        { checkId: "warn-first", severity: "warn", title: "Warn first", detail: "warn detail" },
      ],
    },
    usageLines: ["usage line"],
    channels: {
      rows: [{ id: "quietchat", label: "QuietChat", enabled: true, state: "ok", detail: "ready" }],
    },
    channelIssues: [{ channel: "quietchat", message: "warn msg" }],
    pairingRecovery: { requestId: "req-1", reason: null, remediationHint: null },
    tableWidth: 120,
    ...overrides,
  };
}
