// Status JSON runtime tests cover runtime status payload construction and command dependencies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  readRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";
import type { resolveStatusRuntimeSnapshot } from "./status-runtime-shared.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { createStatusScanResultFixture } from "./status.test-support.ts";

const mocks = vi.hoisted(() => ({
  readBackupRunFreshness: vi.fn(async () => ({
    latest: {
      id: "backup-1",
      createdAt: 123,
      archivePath: "/backups/git",
      status: "ok" as const,
      kind: "git" as const,
    },
  })),
  readConfigFileSnapshot: vi.fn(),
  resolveStatusRuntimeSnapshot: vi.fn(),
  resolveStatusUsageSummary: vi.fn(),
}));

// mock-isolation: Keep store discovery out of these runtime composition tests.
vi.mock("./status-database-engines.js", () => ({
  resolveStatusDatabaseEngines: async () => ({
    source: "unavailable",
    stores: [],
    reason: "Physical store inspection unavailable in fixture.",
  }),
}));

// mock-isolation: Keep config I/O out of this fixture while exercising the real snapshot owner.
vi.mock("../config/config.js", async () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  setAppliedRuntimeConfigSnapshot: (await import("../config/runtime-snapshot.js"))
    .setAppliedRuntimeConfigSnapshot,
}));

// mock-isolation: Status composition consumes retained backup facts without opening their store.
vi.mock("../state/backup-run-records.js", () => ({
  readBackupRunFreshness: mocks.readBackupRunFreshness,
}));

// mock-isolation: Exercise the usage callback without starting Gateway or daemon probes.
vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusRuntimeSnapshot: mocks.resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary: mocks.resolveStatusUsageSummary,
}));

function createScan() {
  return createStatusScanResultFixture({
    env: { OPENCLAW_STATE_DIR: "/tmp/status-json-runtime-state" },
    cfg: { update: { channel: "stable" }, gateway: {} },
    sourceConfig: { gateway: {} },
    summary: { ok: true } as never,
    osSummary: { platform: "linux" } as never,
    memory: null,
    memoryPlugin: { enabled: true, slot: "memory" },
    gatewayMode: "local" as const,
    gatewayConnection: {
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
    remoteUrlMissing: false,
    gatewayReachable: true,
    gatewayProbeAuth: { token: "tok" },
    gatewaySelf: { host: "gateway" },
    gatewayProbeAuthWarning: undefined,
    agentStatus: { agents: [{ id: "main" }], defaultId: "main" } as never,
    secretDiagnostics: [],
    pluginCompatibility: [
      {
        pluginId: "legacy",
        code: "hook-only",
        compatCode: "hook-only-plugin-shape",
        severity: "info",
        message: "warn",
      },
    ],
  });
}

describe("status-json-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValue({
      securityAudit: { summary: { critical: 1 } },
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("preserves the complete status JSON schema with optional sections", async () => {
    const scan = createScan();
    scan.update = {
      root: "/tmp/openclaw",
      installKind: "git",
      packageManager: "npm",
      registry: { latestVersion: "1.2.3" },
      git: {
        root: "/tmp/openclaw",
        sha: null,
        tag: null,
        branch: null,
        upstream: null,
        dirty: null,
        fetchOk: false,
        ahead: 0,
        behind: 0,
        countsCached: true,
        stale: {
          reason: "fetch-failed",
          failedAtMs: 1000,
          detail: "network error",
          runId: "run-1",
        },
      },
    };
    scan.tailscaleMode = "serve";
    scan.gatewayMode = "remote";
    scan.gatewayConnection = {
      url: "wss://gateway.example.com",
      urlSource: "config",
      message: "Gateway target: wss://gateway.example.com",
    };
    scan.gatewayProbeAuthWarning = "warn";
    scan.configDiagnostics = {
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.port", message: "invalid" }],
    };
    scan.secretDiagnostics = ["diag"];
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      securityAudit: { summary: { critical: 1 } },
      health: { ok: true },
      usage: { providers: [] },
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent", installed: true, loadedText: "loaded" },
      nodeService: { label: "node", installed: true, loadedText: "loaded" },
    });

    const result = await resolveStatusJsonOutput({
      scan,
      opts: { ...createStatusGatewayProbeBudget(), deep: true, usage: true },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
    });

    expect(result).toEqual({
      ok: true,
      os: { platform: "linux" },
      update: {
        root: "/tmp/openclaw",
        installKind: "git",
        packageManager: "npm",
        registry: { latestVersion: "1.2.3" },
        git: {
          root: "/tmp/openclaw",
          sha: null,
          tag: null,
          branch: null,
          upstream: null,
          dirty: null,
          fetchOk: false,
          ahead: 0,
          behind: 0,
          countsCached: true,
          stale: {
            reason: "fetch-failed",
            failedAtMs: 1000,
            detail: "network error",
            runId: "run-1",
          },
        },
      },
      updateChannel: "stable",
      updateChannelSource: "config",
      memory: null,
      memoryPlugin: { enabled: true, slot: "memory" },
      databaseEngines: {
        source: "unavailable",
        stores: [],
        reason: "Physical store inspection unavailable in fixture.",
        experimental: false,
        families: [
          {
            id: "state",
            label: "Shared state",
            default: "sqlite",
            override: null,
            fixedLocal: false,
            effective: "sqlite",
          },
          {
            id: "agent",
            label: "Agent data",
            default: "sqlite",
            override: null,
            fixedLocal: false,
            effective: "sqlite",
          },
          {
            id: "workboard",
            label: "Workboard",
            default: "sqlite",
            override: null,
            fixedLocal: false,
            effective: "sqlite",
          },
          {
            id: "logbook",
            label: "Logbook",
            default: "sqlite",
            override: null,
            fixedLocal: false,
            effective: "sqlite",
          },
          {
            id: "team-reports",
            label: "Team Reports",
            default: "sqlite",
            override: null,
            fixedLocal: false,
            effective: "sqlite",
          },
          {
            id: "quarantine",
            label: "Database quarantine",
            default: "sqlite",
            override: null,
            fixedLocal: true,
            effective: "sqlite",
          },
          {
            id: "managed-update",
            label: "Managed update handoffs",
            default: "sqlite",
            override: null,
            fixedLocal: true,
            effective: "sqlite",
          },
          {
            id: "package-activation",
            label: "Package activation journal",
            default: "sqlite",
            override: null,
            fixedLocal: true,
            effective: "sqlite",
          },
        ],
      },
      gateway: {
        mode: "remote",
        url: "wss://gateway.example.com",
        urlSource: "config",
        misconfigured: false,
        reachable: true,
        connectLatencyMs: 42,
        self: { host: "gateway" },
        error: null,
        authWarning: "warn",
      },
      gatewayService: { label: "LaunchAgent", installed: true, loadedText: "loaded" },
      nodeService: { label: "node", installed: true, loadedText: "loaded" },
      agents: { agents: [{ id: "main" }], defaultId: "main" },
      configDiagnostics: {
        path: "/tmp/openclaw.json",
        issues: [{ path: "gateway.port", message: "invalid" }],
      },
      secretDiagnostics: ["diag"],
      securityAudit: { summary: { critical: 1 } },
      health: { ok: true },
      usage: { providers: [] },
      lastHeartbeat: { status: "ok" },
      pluginCompatibility: {
        count: 1,
        warnings: [
          {
            pluginId: "legacy",
            code: "hook-only",
            compatCode: "hook-only-plugin-shape",
            severity: "info",
            message: "warn",
          },
        ],
      },
      backups: {
        latest: {
          id: "backup-1",
          createdAt: 123,
          archivePath: "/backups/git",
          status: "ok",
          kind: "git",
        },
      },
    });
  });

  it("records requested local inspections as not collected for online JSON", async () => {
    const scan = createScan();
    scan.collection = {
      source: "gateway",
      notCollected: [{ fields: ["memory"], reason: "local inspection skipped" }],
    };
    const result = await resolveStatusJsonOutput({
      scan,
      opts: createStatusGatewayProbeBudget(),
      includeSecurityAudit: true,
      includePluginCompatibility: true,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ includeSecurityAudit: false }),
    );
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(result.securityAudit).toMatchObject({ collected: false });
    expect(result.pluginCompatibility).toEqual({
      count: 0,
      warnings: [],
      collected: false,
      reason: "Local plugin inspection is not collected in online status.",
    });
    expect(result.collection?.notCollected).toEqual(
      expect.arrayContaining([expect.objectContaining({ fields: ["securityAudit"] })]),
    );
  });

  it("publishes full runtime policy before resolving explicit online usage", async () => {
    const sourceConfig: OpenClawConfig = {
      plugins: {
        entries: {
          codex: { enabled: true, config: { appServer: { homeScope: "agent" } } },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      gateway: { port: 18789 },
    };
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({ runtimeConfig, sourceConfig });
    mocks.resolveStatusUsageSummary.mockImplementationOnce(async () => {
      expect(readRuntimeConfig().plugins).toEqual(sourceConfig.plugins);
      expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
      return { updatedAt: 123, providers: [] };
    });
    mocks.resolveStatusRuntimeSnapshot.mockImplementationOnce(
      async (input: Parameters<typeof resolveStatusRuntimeSnapshot>[0]) => ({
        usage: await input.resolveUsage?.({
          config: input.config,
          gatewayProbeDeadlineMs: input.gatewayProbeDeadlineMs,
        }),
      }),
    );
    const scan = createScan();
    scan.collection = { source: "gateway", notCollected: [] };

    const result = await resolveStatusJsonOutput({
      scan,
      opts: { ...createStatusGatewayProbeBudget(), usage: true },
      includeSecurityAudit: false,
    });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(mocks.resolveStatusUsageSummary).toHaveBeenCalledOnce();
    expect(result.usage).toEqual({ updatedAt: 123, providers: [] });
  });

  it("builds the full json output for status --json", async () => {
    const scan = createScan();
    const result = await resolveStatusJsonOutput({
      scan,
      opts: { ...createStatusGatewayProbeBudget(1234), deep: true, usage: true, agent: "beta" },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 1234,
      gatewayProbeDeadlineMs: 1234,
      agentId: "beta",
      usage: true,
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: true,
      suppressHealthErrors: undefined,
    });
    expect(mocks.readBackupRunFreshness).toHaveBeenCalledWith(scan.env);
    expect(result.gateway).toMatchObject({
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
    });
    expect(result.gatewayService).toStrictEqual({ label: "LaunchAgent" });
    expect(result.nodeService).toStrictEqual({ label: "node" });
    expect(result.securityAudit).toStrictEqual({ summary: { critical: 1 } });
    expect(result.usage).toStrictEqual({ providers: [] });
    expect(result.health).toStrictEqual({ ok: true });
    expect(result.lastHeartbeat).toStrictEqual({ status: "ok" });
    expect(result.pluginCompatibility).toStrictEqual({
      count: 1,
      warnings: [
        {
          pluginId: "legacy",
          code: "hook-only",
          compatCode: "hook-only-plugin-shape",
          severity: "info",
          message: "warn",
        },
      ],
    });
    expect(result).toMatchObject({
      backups: {
        latest: {
          id: "backup-1",
          createdAt: 123,
          archivePath: "/backups/git",
          status: "ok",
          kind: "git",
        },
      },
    });
  });

  it("skips optional sections when flags are off", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });

    const { env: _env, ...scanWithoutEnv } = createScan();
    const result = await resolveStatusJsonOutput({
      scan: scanWithoutEnv,
      opts: { ...createStatusGatewayProbeBudget(500), deep: false, usage: false },
      includeSecurityAudit: false,
      includePluginCompatibility: false,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 500,
      gatewayProbeDeadlineMs: 500,
      usage: false,
      deep: false,
      gatewayReachable: true,
      includeSecurityAudit: false,
      suppressHealthErrors: undefined,
    });
    expect(mocks.readBackupRunFreshness).toHaveBeenCalledWith({});
    for (const field of [
      "securityAudit",
      "usage",
      "health",
      "lastHeartbeat",
      "pluginCompatibility",
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("preserves failed deep health probes in nonthrowing JSON output", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      securityAudit: undefined,
      usage: undefined,
      health: { error: "gateway health probe timed out" },
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });

    const result = await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { ...createStatusGatewayProbeBudget(500), deep: true },
      includeSecurityAudit: false,
      suppressHealthErrors: true,
    });

    expect(result.health).toEqual({ error: "gateway health probe timed out" });
    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 500,
      gatewayProbeDeadlineMs: 500,
      usage: undefined,
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: false,
      suppressHealthErrors: true,
    });
  });
});
