import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";
import type { buildChannelsTable } from "./status-all/channels.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusScanConfig,
  createStatusScanSharedMocks,
  createStatusSummary,
  loadStatusScanModuleForTest,
} from "./status.scan.test-helpers.js";
import { createTestConfigSnapshot } from "./test-runtime-config-helpers.js";

const mocks = {
  ...createStatusScanSharedMocks("status-scan"),
  buildChannelsTable: vi.fn(),
  callGateway: vi.fn(),
  collectChannelStatusIssues: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(() => new Set<string>()),
  resolveMemorySearchConfig: vi.fn(),
};
const cfg = createStatusMemorySearchConfig();
const url = "ws://127.0.0.1:18789";
let scanStatus: typeof import("./status.scan.js").scanStatus;
let scanStatusJsonFast: typeof import("./status.scan.fast-json.js").scanStatusJsonFast;
let collectStatusScanOverview: typeof import("./status.scan-overview.js").collectStatusScanOverview;
let loggingState: typeof import("../logging/state.js").loggingState;
let originalForceStderr: boolean;

function configure(sourceConfig: OpenClawConfig = cfg, resolvedConfig = sourceConfig) {
  applyStatusScanDefaults(mocks, {
    hasConfiguredChannels: true,
    sourceConfig,
    resolvedConfig,
    summary: createStatusSummary({ byAgent: [] }),
    memoryManager: createStatusMemorySearchManager(),
  });
  mocks.buildChannelsTable.mockResolvedValue({ rows: [], details: [] });
  mocks.callGateway.mockResolvedValue(null);
  mocks.collectChannelStatusIssues.mockReturnValue([]);
  mocks.resolveMemorySearchConfig.mockReturnValue({ store: { databasePath: "/tmp/main.sqlite" } });
}

beforeAll(async () => {
  configure();
  ({ scanStatus } = await loadStatusScanModuleForTest(mocks));
  ({ scanStatusJsonFast } = await loadStatusScanModuleForTest(mocks, { fastJson: true }));
  vi.doMock("./status.scan.runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./status.scan.runtime.js")>()),
    buildChannelsTable: mocks.buildChannelsTable,
    collectChannelStatusIssues: mocks.collectChannelStatusIssues,
  }));
  ({ collectStatusScanOverview } = await import("./status.scan-overview.js"));
  ({ loggingState } = await import("../logging/state.js"));
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(0);
  configure();
  originalForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  loggingState.forceConsoleToStderr = originalForceStderr;
});

function heartbeat(waitingForRoute: boolean) {
  return {
    defaultAgentId: "main",
    agents: [{ agentId: "main", enabled: true, every: "30m", everyMs: 1_800_000, waitingForRoute }],
  };
}

function coldStartEnv(token?: string) {
  const entries = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
    (entry) => entry.configurable !== false,
  );
  const prefixes = entries.map(
    (entry) => `${entry.channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`,
  );
  const keys = new Set(entries.flatMap((entry) => entry.channelEnvVars ?? []));
  for (const key of Object.keys(process.env)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      keys.add(key);
    }
  }
  return {
    ...Object.fromEntries([...keys].map((key) => [key, undefined])),
    OPENCLAW_TWITCH_ACCESS_TOKEN: token,
    TELEGRAM_BOT_TOKEN: undefined,
    VITEST: undefined,
    VITEST_POOL_ID: undefined,
    NODE_ENV: undefined,
  };
}

const runtimeDiagnostics = {
  degradedSecretOwners: [],
  degradedPlugins: [],
  modelReasoningWarning: "Model ollama/qwen3:4b emitted hidden reasoning; set reasoning:true.",
  sqliteWal: createSqliteWalHealth(),
  startupMigrationWarning: "Retained legacy state; run openclaw doctor --fix.",
  installationReplacementWarning: "Installation replaced; draining before handoff.",
  secretEgressProxy: {
    state: "degraded",
    message: "Check OpenSSL, then retry.",
    caExpiresAt: "2036-09-01T00:00:00.000Z",
    failedCertificates: 1,
  },
  childRuntime: { execPath: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node", available: false },
};

function expectChannels(
  options: NonNullable<Parameters<typeof buildChannelsTable>[1]> & { config?: OpenClawConfig } = {},
) {
  const { config = cfg, ...overrides } = options;
  expect(mocks.buildChannelsTable).toHaveBeenCalledExactlyOnceWith(config, {
    showSecrets: true,
    sourceConfig: config,
    includeSetupFallbackPlugins: false,
    liveChannelStatus: null,
    ...overrides,
  });
}

function expectCall(mock: unknown, fields: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

describe("status scans", () => {
  it.each([true, false])(
    "uses Gateway heartbeat when its runtime snapshot is available=%s",
    async (available) => {
      mocks.getStatusSummary.mockResolvedValue({
        ...createStatusSummary(),
        heartbeat: heartbeat(true),
      });
      mocks.probeGateway.mockResolvedValue({
        ...createUnreachableGatewayProbe(url, "timeout"),
        ok: true,
        status: available ? { heartbeat: heartbeat(false) } : null,
      });
      mocks.callGateway.mockRejectedValue(new Error("missing scope: operator.read"));

      const result = await scanStatus(createStatusGatewayProbeBudget());

      expect(result.summary.heartbeat).toEqual(heartbeat(!available));
      expect(mocks.callGateway).toHaveBeenCalledTimes(available ? 0 : 1);
      expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
      expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
      expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
      expectChannels();
    },
  );

  it("collects live channel and runtime diagnostics for deep text status", async () => {
    const runtime = {
      ...runtimeDiagnostics,
      pluginReload: { phase: "reloading", pluginIds: ["composio"] },
    };
    const liveChannelStatus = { ok: true, accounts: [] };
    mocks.callGateway.mockImplementation(async ({ method }: { method: string }) =>
      method === "status" ? runtime : liveChannelStatus,
    );
    mocks.probeGateway.mockResolvedValue({
      ...createUnreachableGatewayProbe(url, "timeout"),
      ok: true,
    });

    const result = await scanStatus({ ...createStatusGatewayProbeBudget(5000), deep: true });

    expect(result.summary).toMatchObject(runtime);
    expectCall(mocks.callGateway, {
      method: "channels.status",
      params: { probe: false, timeoutMs: 5000 },
    });
    expectChannels({ includeSetupFallbackPlugins: true, liveChannelStatus });
  });

  it("skips gateway and update probes on cold-start text status", async () => {
    applyStatusScanDefaults(mocks, {
      sourceConfig: createStatusScanConfig({ plugins: { enabled: false } }),
    });
    const result = await scanStatus(createStatusGatewayProbeBudget());
    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(result.summary.sessions.count).toBe(0);
  });

  it("preserves config diagnostics and source credentials on the lean JSON path", async () => {
    const sourceConfig: OpenClawConfig = {
      channels: {
        telegram: { botToken: { source: "file", provider: "vault", id: "/telegram/bot-token" } },
      },
    };
    const resolvedConfig = { channels: { telegram: { botToken: "resolved-token" } } };
    configure(sourceConfig, resolvedConfig);
    const configDiagnostics = {
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.port", message: "invalid port" }],
    };
    mocks.readConfigFileSnapshotWithPluginMetadata.mockResolvedValue({
      snapshot: {
        ...createTestConfigSnapshot(sourceConfig, sourceConfig, configDiagnostics.path),
        exists: false,
        raw: null,
        parsed: sourceConfig,
        valid: false,
        issues: configDiagnostics.issues,
      },
    });

    const result = await scanStatusJsonFast(createStatusGatewayProbeBudget(1234), {} as never);

    expect(result).toMatchObject({
      configDiagnostics,
      cfg: resolvedConfig,
      sourceConfig,
      memory: null,
    });
    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
    expect(mocks.resolveMemorySearchConfig).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expectCall(mocks.resolveCommandSecretRefsViaGateway, { gatewaySecretResolveTimeoutMs: 1234 });
    expectCall(mocks.probeGateway, { config: resolvedConfig, timeoutMs: 1234, env: process.env });
    expectCall(mocks.getUpdateCheckResult, {
      timeoutMs: 1234,
      fetchGit: false,
      includeRegistry: false,
    });
  });

  it("collects memory and plugin evidence with network updates for JSON --all", async () => {
    const notice = {
      pluginId: "legacy-plugin",
      code: "hook-only",
      severity: "warn",
      message: "legacy hooks",
    };
    mocks.buildPluginCompatibilityNotices.mockReturnValue([notice]);
    mocks.callGateway.mockResolvedValue({ sessions: 1 });
    const result = await scanStatusJsonFast(
      { ...createStatusGatewayProbeBudget(), all: true },
      {} as never,
    );
    expect(result.pluginCompatibility).toEqual([notice]);
    expect(result.memory).toStrictEqual({ agentId: "main", files: 0, chunks: 0, dirty: false });
    expectCall(mocks.callGateway, { method: "status", timeoutMs: 2000 });
    expectCall(mocks.getUpdateCheckResult, {
      timeoutMs: 10_000,
      fetchGit: true,
      includeRegistry: true,
    });
  });

  it("uses manifest environment credentials for cold-start JSON", async () => {
    await withEnvAsync(coldStartEnv("token"), async () => {
      await scanStatusJsonFast(createStatusGatewayProbeBudget(), {} as never);
    });
    expect(mocks.probeGateway).toHaveBeenCalledOnce();
    expectCall(mocks.getUpdateCheckResult, { fetchGit: false, includeRegistry: false });
  });

  it("uses gateway fallback overrides for channels.status when requested", async () => {
    const gatewaySnapshot: NonNullable<
      Parameters<typeof collectStatusScanOverview>[0]["gatewaySnapshot"]
    > = {
      gatewayConnection: {
        url,
        urlSource: "missing gateway.remote.url (fallback local)",
        message: "fallback",
      },
      remoteUrlMissing: true,
      gatewayMode: "remote",
      gatewayProbeAuth: { token: "tok" },
      gatewayProbe: { ...createUnreachableGatewayProbe(url, "timeout"), ok: true },
      gatewayReachable: true,
      gatewaySelf: null,
      gatewayCallOverrides: { url, token: "tok" },
    };

    const sourceConfig: OpenClawConfig = { session: { dmScope: "per-peer" } };
    mocks.readConfigFileSnapshotWithPluginMetadata.mockResolvedValue({
      snapshot: {
        ...createTestConfigSnapshot(sourceConfig, { session: {} }, mocks.resolveConfigPath()),
        exists: false,
        raw: null,
        parsed: sourceConfig,
      },
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { session: {} },
      diagnostics: ["secret warning"],
    });
    mocks.callGateway.mockImplementation(async ({ method }: { method: string }) =>
      method === "status" ? {} : { channelAccounts: {} },
    );
    mocks.collectChannelStatusIssues.mockReturnValue([{ channel: "quietchat", message: "boom" }]);
    const result = await collectStatusScanOverview({
      commandName: "status --all",
      opts: { ...createStatusGatewayProbeBudget(1234), deep: true },
      showSecrets: false,
      useGatewayCallOverridesForChannelsStatus: true,
      gatewaySnapshot,
    });

    expect(result).toMatchObject({
      channelsStatus: { channelAccounts: {} },
      channelIssues: [{ channel: "quietchat", message: "boom" }],
    });
    expectCall(mocks.callGateway, { method: "channels.status", url, token: "tok" });
    expectChannels({
      config: { session: {} },
      sourceConfig: { session: { dmScope: "per-peer" } },
      showSecrets: false,
      includeSetupFallbackPlugins: true,
      liveChannelStatus: { channelAccounts: {} },
    });
  });
});
