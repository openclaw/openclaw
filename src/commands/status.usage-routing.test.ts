import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStatusHealthSessionsCommands } from "../cli/program/register.status-health-sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import type { UsageSummary } from "../infra/provider-usage.types.js";
import { defaultRuntime } from "../runtime.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { statusJsonCommand } from "./status-json.js";
import type { StatusUsageSummaryOptions } from "./status-usage.runtime.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.js";
import type { StatusScanResult } from "./status.scan-result.js";
import type { scanStatus } from "./status.scan.js";
import { resolveGatewayProbeSnapshot } from "./status.scan.shared.js";
import { baseStatusServices, createStatusScanResultFixture } from "./status.test-support.js";

const mocks = vi.hoisted(() => ({
  scan: vi.fn<(opts: Parameters<typeof scanStatus>[0]) => Promise<StatusScanResult>>(),
  usage: vi.fn<(options: StatusUsageSummaryOptions) => Promise<UsageSummary>>(),
  probe: vi.fn<typeof import("../gateway/probe.js").probeGateway>(),
  callGateway:
    vi.fn<
      (params: Parameters<typeof import("../gateway/call.js").callGateway>[0]) => Promise<unknown>
    >(),
  gatewayService: vi.fn(),
  nodeService: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("./status.scan.js", () => ({ scanStatus: mocks.scan }));
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast: mocks.scan }));
vi.mock("./status.scan-overview.js", () => ({
  resolveStatusSummaryFromOverview: async () => createStatusScanResultFixture().summary,
  collectStatusScanOverview: async ({ opts }: { opts: Parameters<typeof scanStatus>[0] }) => {
    const scan = await mocks.scan(opts);
    return {
      ...scan,
      coldStart: false,
      hasConfiguredChannels: false,
      skipColdStartNetworkChecks: false,
      gatewaySnapshot: {
        gatewayConnection: scan.gatewayConnection,
        remoteUrlMissing: scan.remoteUrlMissing,
        gatewayMode: scan.gatewayMode,
        gatewayProbeAuth: scan.gatewayProbeAuth,
        gatewayProbeAuthWarning: scan.gatewayProbeAuthWarning,
        gatewayProbe: scan.gatewayProbe,
        gatewayReachable: scan.gatewayReachable,
        gatewaySelf: scan.gatewaySelf,
      },
      runtimeDegradation: { degradedSecretOwners: [], degradedPlugins: [] },
      channelsStatus: null,
    } satisfies StatusScanOverviewResult;
  },
}));
vi.mock("./status-usage.runtime.js", () => ({
  resolveStatusUsageSummary: mocks.usage,
}));
vi.mock("../gateway/probe.js", () => ({ probeGateway: mocks.probe }));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
}));
vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: async () => ({ auth: { token: "fixture-token" } }),
}));
vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.gatewayService,
  getNodeDaemonStatusSummary: mocks.nodeService,
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: async () => ({
    exists: true,
    valid: true,
    path: "/tmp/status-usage-fixture.json",
    issues: [],
  }),
}));
vi.mock("../daemon/diagnostics.js", () => ({ readLastGatewayErrorLine: async () => null }));
vi.mock("../infra/ports-inspect.js", () => ({ inspectPortUsage: async () => null }));
vi.mock("../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart-sentinel.js")>()),
  readRestartSentinelReadOnly: async () => null,
}));
vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  loadExecApprovalsReadOnly: () => ({ version: 1, agents: {} }),
}));
vi.mock("../skills/discovery/status.js", () => ({ buildWorkspaceSkillReadiness: () => null }));
vi.mock("../plugins/status.js", async () => ({
  ...(await import("../plugins/status-compatibility.js")),
  buildPluginCompatibilityNotices: () => [],
  withPluginDiagnosticsReport: async <T>(
    _params: unknown,
    consume: (report: object) => T | Promise<T>,
  ) => consume({}),
}));
vi.mock("./status-all/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-all/gateway.js")>()),
  readFileTailLines: async () => [],
}));
vi.mock("../state/backup-run-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/backup-run-records.js")>()),
  readBackupRunFreshness: async () => ({}),
}));
vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: async () => ({
    ts: 0,
    summary: { critical: 0, warn: 0, info: 0 },
    findings: [],
  }),
}));

const config: OpenClawConfig = {
  gateway: { mode: "local", bind: "loopback" },
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, work: {} },
  },
};

function usageSummary(displayName: string, usedPercent: number): UsageSummary {
  return {
    updatedAt: 1_000,
    providers: [{ provider: "fixture", displayName, windows: [{ label: "Window", usedPercent }] }],
  };
}

const summaries = {
  default: usageSummary("Fixture Default", 25),
  work: usageSummary("Fixture Work", 60),
  empty: { updatedAt: 1_000, providers: [] },
  error: {
    updatedAt: 1_000,
    providers: [
      {
        provider: "fixture",
        displayName: "Fixture Default",
        windows: [],
        error: "fixture quota unavailable",
      },
    ],
  },
} satisfies Record<string, UsageSummary>;

describe("status usage routing through Commander", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const scan = createStatusScanResultFixture({
      cfg: config,
      sourceConfig: config,
      gatewayMode: "local",
      gatewayReachable: false,
      gatewayProbe: null,
      gatewayProbeAuth: {},
      gatewayProbeAuthWarning: undefined,
      gatewayConnection: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "Gateway target: ws://127.0.0.1:18789",
      },
      memory: null,
      memoryPlugin: { enabled: false, slot: null, reason: "fixture" },
      pluginCompatibility: [],
    });
    mocks.scan.mockResolvedValue({
      ...scan,
      agentStatus: {
        ...scan.agentStatus,
        bootstrapPendingCount: 0,
        totalSessions: 0,
        agents: [],
      },
    });
    mocks.gatewayService.mockResolvedValue(baseStatusServices.gatewayService);
    mocks.nodeService.mockResolvedValue(baseStatusServices.nodeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["text", "commander-json", "fast-json"])(
    "shares the command deadline across remote usage and deep probes (%s)",
    async (mode) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const scan = await mocks.scan(createStatusGatewayProbeBudget());
        const remoteConfig: OpenClawConfig = {
          ...config,
          gateway: { mode: "remote", remote: { url: "wss://gateway.example.com" } },
        };
        mocks.scan.mockImplementation(async (opts) => ({
          ...scan,
          cfg: remoteConfig,
          sourceConfig: remoteConfig,
          ...(await resolveGatewayProbeSnapshot({
            cfg: remoteConfig,
            configPath: "/tmp/status-usage-fixture.json",
            env: {},
            opts,
          })),
        }));
        mocks.probe.mockImplementation(async () => {
          clock.mockReturnValue(22_000);
          return {
            ...createUnreachableGatewayProbe("wss://gateway.example.com", "fixture"),
            ok: true,
            error: null,
          };
        });
        mocks.usage.mockImplementation(async () => {
          clock.mockReturnValue(30_000);
          return summaries.default;
        });
        mocks.callGateway.mockImplementation(async ({ method }) => {
          if (method === "health") {
            clock.mockReturnValue(35_000);
            return { ok: true, channels: {}, agents: [], ts: 1, durationMs: 0 };
          }
          return null;
        });
        if (mode === "fast-json") {
          await statusJsonCommand({ usage: true, deep: true }, defaultRuntime);
        } else {
          const program = new Command();
          registerStatusHealthSessionsCommands(program);
          await program.parseAsync(
            ["status", "--usage", "--deep", ...(mode === "commander-json" ? ["--json"] : [])],
            { from: "user" },
          );
        }

        expect(mocks.runtime.error).not.toHaveBeenCalled();
        expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
        expect(mocks.usage).toHaveBeenCalledExactlyOnceWith({
          config: remoteConfig,
          timeoutMs: 38_000,
          gatewayProbeDeadlineMs: 60_000,
        });
        expect(
          mocks.callGateway.mock.calls.map(([input]) => [input.method, input.timeoutMs]),
        ).toEqual([
          ["health", 30_000],
          ["last-heartbeat", 25_000],
        ]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([
    {
      name: "plain usage",
      args: ["--usage"],
      summary: summaries.default,
      line: "Window: 75% left",
    },
    {
      name: "full report usage",
      args: ["--all", "--usage"],
      summary: summaries.default,
      line: "Window: 75% left",
    },
    {
      name: "full report explicit agent",
      args: ["--all", "--usage", "--agent", "work"],
      summary: summaries.work,
      agentId: "work",
      line: "Window: 40% left",
    },
    { name: "full report without usage", args: ["--all"], summary: undefined },
    {
      name: "full report empty usage",
      args: ["--all", "--usage"],
      summary: summaries.empty,
      line: "Usage: no provider usage available.",
    },
    {
      name: "full report usage error",
      args: ["--all", "--usage"],
      summary: summaries.error,
      line: "Fixture Default: fixture quota unavailable",
    },
    {
      name: "JSON full report explicit agent",
      args: ["--json", "--all", "--usage", "--agent", "work"],
      summary: summaries.work,
      agentId: "work",
    },
  ])("$name", async ({ args, summary, agentId, line }) => {
    mocks.usage.mockResolvedValue(summary ?? summaries.default);
    const program = new Command();
    registerStatusHealthSessionsCommands(program);
    await program.parseAsync(["status", ...args], { from: "user" });
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    const output = mocks.runtime.log.mock.calls.map(([value]) => String(value)).join("\n");
    if (args.includes("--json")) {
      expect(JSON.parse(output).usage).toEqual(summary);
    } else {
      expect(output).toContain("OpenClaw status");
      if (args.includes("--all")) {
        expect(output).toContain("Diagnosis (read-only)");
      }
      if (line) {
        expect(output).toContain(line);
        for (const provider of summary?.providers ?? []) {
          expect(output).toContain(provider.displayName);
        }
      } else {
        expect(output).not.toContain("Usage:");
      }
    }
    if (summary) {
      expect(mocks.usage).toHaveBeenCalledOnce();
      expect(mocks.usage).toHaveBeenCalledWith({
        config,
        timeoutMs: 60_000,
        gatewayProbeDeadlineMs: 60_000,
        ...(agentId ? { agentId } : {}),
      });
    } else {
      expect(mocks.usage).not.toHaveBeenCalled();
    }
  });

  it.each([
    { args: [], timeoutMs: undefined, elapsedMs: 22_000, expected: 38_000 },
    { args: ["--all"], timeoutMs: undefined, elapsedMs: 22_000, expected: 38_000 },
    { args: ["--json", "--all"], timeoutMs: undefined, elapsedMs: 22_000, expected: 38_000 },
    { args: [], timeoutMs: 1234, elapsedMs: 234, expected: 1000 },
    { args: ["--all"], timeoutMs: 1234, elapsedMs: 234, expected: 1000 },
    { args: ["--json", "--all"], timeoutMs: 1234, elapsedMs: 234, expected: 1000 },
  ])(
    "bounds usage after readiness ($args, $timeoutMs)",
    async ({ args, timeoutMs, elapsedMs, expected }) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const scan = await mocks.scan(createStatusGatewayProbeBudget(timeoutMs));
        mocks.scan.mockImplementation(async () => {
          clock.mockReturnValue(elapsedMs);
          return scan;
        });
        mocks.usage.mockResolvedValue(summaries.default);
        const program = new Command();
        registerStatusHealthSessionsCommands(program);
        await program.parseAsync(
          ["status", "--usage", ...args, ...(timeoutMs ? ["--timeout", String(timeoutMs)] : [])],
          { from: "user" },
        );

        expect(mocks.runtime.error).not.toHaveBeenCalled();
        expect(mocks.runtime.exit).not.toHaveBeenCalled();
        expect(mocks.usage).toHaveBeenCalledExactlyOnceWith({
          config,
          timeoutMs: expected,
          gatewayProbeDeadlineMs: timeoutMs ?? 60_000,
        });
      } finally {
        clock.mockRestore();
      }
    },
  );
});
