import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { OpenClawConfig } from "../config/types.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusScanConfig,
  createStatusScanSharedMocks,
  createStatusSummary,
  loadStatusScanModuleForTest,
  withTemporaryEnv,
} from "./status.scan.test-helpers.js";

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
let commandConfigSnapshot: typeof import("../cli/command-config-snapshot.js");
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
  vi.doMock("./status.scan.runtime.js", () => ({
    statusScanRuntime: {
      buildChannelsTable: mocks.buildChannelsTable,
      collectChannelStatusIssues: mocks.collectChannelStatusIssues,
    },
  }));
  ({ collectStatusScanOverview } = await import("./status.scan-overview.js"));
  commandConfigSnapshot = await import("../cli/command-config-snapshot.js");
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
      expect(mocks.buildChannelsTable).toHaveBeenCalledExactlyOnceWith(cfg, {
        showSecrets: true,
        sourceConfig: cfg,
        includeSetupFallbackPlugins: false,
        liveChannelStatus: null,
      });
    },
  );

  it("collects live channel and runtime diagnostics for deep text status", async () => {
    const sqliteWal = createSqliteWalHealth();
    const runtime = {
      degradedSecretOwners: [],
      degradedPlugins: [],
      sqliteWal,
      startupMigrationWarning: "Retained legacy state; run openclaw doctor --fix.",
      installationReplacementWarning: "Installation replaced; draining before handoff.",
      secretEgressProxy: { state: "degraded", message: "Check OpenSSL, then retry." },
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
    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: cfg,
      configPath: mocks.resolveConfigPath(),
      method: "channels.status",
      params: { probe: false, timeoutMs: 5000 },
      timeoutMs: 5000,
    });
    expect(mocks.buildChannelsTable).toHaveBeenCalledExactlyOnceWith(cfg, {
      showSecrets: true,
      sourceConfig: cfg,
      includeSetupFallbackPlugins: true,
      liveChannelStatus,
    });
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
    mocks.readBestEffortConfigSnapshot.mockResolvedValue({
      config: sourceConfig,
      sourceConfig,
      configDiagnostics,
    });

    const result = await scanStatusJsonFast(createStatusGatewayProbeBudget(1234), {} as never);

    expect(result.configDiagnostics).toEqual(configDiagnostics);
    expect(result.cfg).toEqual(resolvedConfig);
    expect(result.sourceConfig).toEqual(sourceConfig);
    expect(result.memory).toBeNull();
    expect(mocks.ensurePluginRegistryLoaded).not.toHaveBeenCalled();
    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
    expect(mocks.resolveMemorySearchConfig).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({ gatewaySecretResolveTimeoutMs: 1234 }),
    );
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ config: resolvedConfig, timeoutMs: 1234, env: process.env }),
    );
    expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1234, fetchGit: false, includeRegistry: false }),
    );
    expect(mocks.getStatusSummary).toHaveBeenCalledWith({
      config: resolvedConfig,
      sourceConfig,
      includeChannelSummary: false,
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
    expect(mocks.getMemorySearchManager).toHaveBeenCalledExactlyOnceWith({
      cfg,
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "status", timeoutMs: 2000 }),
    );
    expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 10_000, fetchGit: true, includeRegistry: true }),
    );
  });

  it.each(["token"])(
    "uses manifest environment credentials for cold-start JSON (%s)",
    async (token) => {
      await withTemporaryEnv(coldStartEnv(token), async () => {
        await scanStatusJsonFast(createStatusGatewayProbeBudget(), {} as never);
      });
      expect(mocks.probeGateway).toHaveBeenCalledTimes(token ? 1 : 0);
      if (token) {
        expect(mocks.getUpdateCheckResult).toHaveBeenCalledWith(
          expect.objectContaining({ fetchGit: false, includeRegistry: false }),
        );
      } else {
        expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
      }
    },
  );

  describe("collectStatusScanOverview", () => {
    const sqliteWal = createSqliteWalHealth();
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

    beforeEach(() => {
      mocks.readBestEffortConfigSnapshot.mockResolvedValue({
        config: { session: {} },
        sourceConfig: { session: { raw: true } },
        configDiagnostics: null,
      });
      mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
        resolvedConfig: { session: {} },
        diagnostics: ["secret warning"],
      });
      vi.spyOn(commandConfigSnapshot, "readCommandConfigSnapshot");
      mocks.callGateway.mockImplementation(async ({ method }: { method: string }) =>
        method === "status"
          ? {
              secretEgressProxy: {
                state: "degraded",
                caExpiresAt: "2036-09-01T00:00:00.000Z",
                failedCertificates: 1,
                message: "Check OpenSSL, then retry.",
              },
              degradedSecretOwners: [],
              degradedPlugins: [],
              startupMigrationWarning: "Retained legacy state; run openclaw doctor --fix.",
              installationReplacementWarning: "Installation replaced; draining before handoff.",
              childRuntime: {
                execPath: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node",
                available: false,
              },
              sqliteWal,
            }
          : { channelAccounts: {} },
      );
      mocks.collectChannelStatusIssues.mockReturnValue([{ channel: "quietchat", message: "boom" }]);
    });

    it("uses gateway fallback overrides for channels.status when requested", async () => {
      const result = await collectStatusScanOverview({
        commandName: "status --all",
        opts: { ...createStatusGatewayProbeBudget(1234), deep: true },
        showSecrets: false,
        useGatewayCallOverridesForChannelsStatus: true,
        gatewaySnapshot,
      });

      expect(result.runtimeDegradation?.secretEgressProxy?.message).toBe(
        "Check OpenSSL, then retry.",
      );
      expect(result.runtimeDegradation?.sqliteWal).toEqual(sqliteWal);
      expect(commandConfigSnapshot.readCommandConfigSnapshot).toHaveBeenCalledOnce();
      expect(mocks.callGateway).toHaveBeenCalledTimes(2);
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({ method: "channels.status", url, token: "tok" }),
      );
      expect(result.channelsStatus).toEqual({ channelAccounts: {} });
      expect(mocks.buildChannelsTable).toHaveBeenCalledExactlyOnceWith(
        { session: {} },
        {
          sourceConfig: { session: { raw: true } },
          showSecrets: false,
          includeSetupFallbackPlugins: true,
          liveChannelStatus: { channelAccounts: {} },
        },
      );
      expect(result.channelIssues).toEqual([{ channel: "quietchat", message: "boom" }]);
      expect(result.runtimeDegradation?.startupMigrationWarning).toBe(
        "Retained legacy state; run openclaw doctor --fix.",
      );
      expect(result.runtimeDegradation?.installationReplacementWarning).toBe(
        "Installation replaced; draining before handoff.",
      );
      expect(result.runtimeDegradation?.childRuntime).toEqual({
        execPath: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node",
        available: false,
      });
    });
  });
});
