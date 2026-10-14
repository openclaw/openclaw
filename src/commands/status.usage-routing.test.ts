import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { registerStatusHealthSessionsCommands } from "../cli/program/register.status-health-sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import type { UsageSummary } from "../infra/provider-usage.types.js";
import { createCompatibilityNotice } from "../plugins/status.test-fixtures.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { createUnreachableGatewayProbe } from "./gateway-status/test-support.js";
import { statusJsonCommand } from "./status-json.js";
import type { StatusUsageSummaryOptions } from "./status-usage.runtime.js";
import { statusCommand } from "./status.command.js";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.js";
import type { StatusScanResult } from "./status.scan-result.js";
import type { scanStatus } from "./status.scan.js";
import { resolveGatewayProbeSnapshot } from "./status.scan.shared.js";
import { baseStatusServices, createStatusScanResultFixture } from "./status.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  scan: vi.fn<(opts: Parameters<typeof scanStatus>[0]) => Promise<StatusScanResult>>(),
  usage: vi.fn<(options: StatusUsageSummaryOptions) => Promise<UsageSummary>>(),
  probe: vi.fn<typeof import("../gateway/probe.js").probeGateway>(),
  callGateway:
    vi.fn<
      (params: Parameters<typeof import("../gateway/call.js").callGateway>[0]) => Promise<unknown>
    >(),
  audit: vi.fn(),
  nodeConfig: vi.fn(),
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
vi.mock("../security/audit.runtime.js", () => ({ runSecurityAudit: mocks.audit }));
vi.mock("../node-host/config.js", () => ({ loadNodeHostConfig: mocks.nodeConfig }));

Object.assign(mocks.runtime, createTestRuntime());

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
} satisfies Record<string, UsageSummary>;

let currentScan: StatusScanResult;
async function runStatusOutput(opts: Parameters<typeof statusCommand>[0] = {}) {
  mocks.runtime.log.mockClear();
  await statusCommand(opts, defaultRuntime);
  return mocks.runtime.log.mock.calls.map(([value]) => String(value)).join("\n");
}
function setScan(overrides: Partial<StatusScanResult>) {
  currentScan = { ...currentScan, ...overrides };
  mocks.scan.mockResolvedValue(currentScan);
}
const diagnostics = {
  path: "/tmp/openclaw.json",
  issues: [{ path: "gateway.port", message: "invalid" }],
};

describe("status commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_PROFILE", "isolated");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
    mocks.callGateway.mockReset().mockResolvedValue(null);
    mocks.usage.mockReset().mockResolvedValue(summaries.default);
    mocks.nodeConfig.mockReset().mockResolvedValue(null);
    mocks.audit.mockReset().mockResolvedValue({
      ts: 0,
      summary: { critical: 1, warn: 1, info: 1 },
      findings: [
        {
          checkId: "critical",
          severity: "critical",
          title: "Critical",
          detail: "Details\ncontinued",
          remediation: "Repair",
        },
        { checkId: "warn", severity: "warn", title: "Warning", detail: "Details" },
        { checkId: "info", severity: "info", title: "Info", detail: "Details" },
      ],
    });
    vi.spyOn(performance, "now").mockReturnValue(0);
    currentScan = structuredClone(
      createStatusScanResultFixture({
        cfg: config,
        sourceConfig: config,
        gatewayMode: "local",
        gatewayReachable: false,
        gatewayProbe: createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
        gatewaySelf: null,
        gatewayProbeAuth: {},
        gatewayProbeAuthWarning: undefined,
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Gateway target: ws://127.0.0.1:18789",
        },
        memory: null,
        memoryPlugin: { enabled: true, slot: "memory-core" },
        pluginCompatibility: [],
        channels: {
          rows: [
            { id: "whatsapp", label: "WhatsApp", enabled: true, state: "ok", detail: "linked" },
            {
              id: "signal",
              label: "Signal",
              enabled: true,
              state: "warn",
              detail: "gateway warning",
            },
          ],
          details: [],
        },
        channelIssues: [
          {
            channel: "signal",
            accountId: "default",
            kind: "runtime",
            message: "signal-cli unreachable",
          },
        ],
      }),
    );
    const summary = structuredClone(currentScan.summary);
    const update = structuredClone(currentScan.update);
    currentScan.gatewayConnection.urlSource = "";
    currentScan.summary.queuedSystemEvents = [];
    currentScan.summary.heartbeat.agents = [];
    for (const row of currentScan.summary.sessions.recent) {
      delete row.runtime;
      row.configuredModel = null;
      row.selectedModel = null;
    }
    const git = currentScan.update.git;
    if (!git) {
      throw new Error("missing git fixture");
    }
    Object.assign(git, { behind: 0, tag: null });
    currentScan.update.registry = { latestVersion: VERSION };
    mocks.scan.mockResolvedValue({
      ...currentScan,
      gatewayProbe: null,
      gatewaySelf: { host: "gateway", version: "1.2.3" },
      channels: { rows: [], details: [] },
      channelIssues: [],
      memoryPlugin: { enabled: false, slot: null, reason: "fixture" },
      summary,
      update,
      agentStatus: {
        ...currentScan.agentStatus,
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
    vi.unstubAllEnvs();
  });

  it.each(["text", "commander-json", "fast-json"])(
    "shares the command deadline across remote usage and deep probes (%s)",
    async (mode) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        mocks.audit.mockResolvedValue({
          ts: 0,
          summary: { critical: 0, warn: 0, info: 0 },
          findings: [],
        });
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

  it.each<{
    name: string;
    args: string[];
    summary?: UsageSummary;
    agentId?: string;
    line?: string;
    timeoutMs?: number;
    elapsedMs?: number;
  }>([
    {
      name: "full report explicit agent",
      args: ["--all", "--usage", "--agent", "work"],
      summary: summaries.work,
      agentId: "work",
      line: "Window: 40% left",
    },
    { name: "full report without usage", args: ["--all"], summary: undefined },
    {
      name: "JSON full report explicit agent",
      args: ["--json", "--all", "--usage", "--agent", "work"],
      summary: summaries.work,
      agentId: "work",
    },
    {
      name: "full report with the budget remaining after readiness",
      args: ["--all", "--usage", "--timeout", "1234"],
      summary: summaries.default,
      line: "Window: 75% left",
      timeoutMs: 1234,
      elapsedMs: 234,
    },
  ])("$name", async ({ args, summary, agentId, line, timeoutMs = 60_000, elapsedMs = 0 }) => {
    if (elapsedMs) {
      const clock = vi.spyOn(performance, "now");
      const scan = await mocks.scan(createStatusGatewayProbeBudget(timeoutMs));
      mocks.scan.mockImplementation(async () => {
        clock.mockReturnValue(elapsedMs);
        return scan;
      });
    }
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
      expect(output).toContain("Diagnosis (read-only)");
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
      expect(mocks.usage).toHaveBeenCalledExactlyOnceWith({
        config,
        timeoutMs: timeoutMs - elapsedMs,
        gatewayProbeDeadlineMs: timeoutMs,
        ...(agentId ? { agentId } : {}),
      });
    } else {
      expect(mocks.usage).not.toHaveBeenCalled();
    }
  });

  it("includes full JSON diagnostics only when requested", async () => {
    const warning = createCompatibilityNotice({ pluginId: "legacy-plugin", code: "hook-only" });
    setScan({ pluginCompatibility: [warning] });
    const fast = JSON.parse(await runStatusOutput({ json: true }));
    expect(fast).not.toHaveProperty("securityAudit");
    expect(fast).not.toHaveProperty("pluginCompatibility");
    expect(mocks.audit).not.toHaveBeenCalled();
    const full = JSON.parse(await runStatusOutput({ json: true, all: true }));
    expect(full.securityAudit.summary.critical).toBe(1);
    expect(full.pluginCompatibility).toEqual({ count: 1, warnings: [warning] });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
  });

  it.each(["JSON", "text", "failing deep health"])(
    "reports present config diagnostics in %s output",
    async (mode) => {
      setScan({ configDiagnostics: diagnostics, gatewayReachable: mode !== "JSON" });
      if (mode === "failing deep health") {
        mocks.callGateway.mockRejectedValueOnce(new Error("gateway health unavailable"));
        await expect(runStatusOutput({ deep: true })).rejects.toThrow("gateway health unavailable");
        expect(mocks.runtime.log.mock.calls.flat().join("\n")).toContain("Config diagnostics:");
        return;
      }
      if (mode === "JSON") {
        expect(JSON.parse(await runStatusOutput({ json: true })).configDiagnostics).toEqual(
          diagnostics,
        );
      } else {
        mocks.callGateway.mockResolvedValueOnce({
          ok: true,
          channels: {},
          agents: [],
          ts: 1,
          durationMs: 0,
        });
        const text = await runStatusOutput({ deep: true });
        for (const expected of [
          "Critical",
          "Warning",
          "Fix: Repair",
          "Config diagnostics:",
          "Config file is invalid: /tmp/openclaw.json",
          "gateway.port: invalid",
          "openclaw --profile isolated doctor --fix",
        ]) {
          expect(text).toContain(expected);
        }
      }
      setScan({ configDiagnostics: null });
      if (mode === "JSON") {
        expect(JSON.parse(await runStatusOutput({ json: true }))).not.toHaveProperty(
          "configDiagnostics",
        );
      } else {
        expect(await runStatusOutput()).not.toContain("Config diagnostics:");
      }
    },
  );

  it("prints verbose session cache details and compatibility warnings", async () => {
    const recent = currentScan.summary.sessions.recent.map((row) => ({
      ...row,
      inputTokens: 2000,
      outputTokens: 3000,
      cacheRead: 2000,
      cacheWrite: 1000,
      totalTokens: 5000,
      percentUsed: 50,
    }));
    setScan({
      summary: { ...currentScan.summary, sessions: { ...currentScan.summary.sessions, recent } },
      pluginCompatibility: [
        createCompatibilityNotice({ pluginId: "legacy-plugin", code: "hook-only" }),
      ],
    });
    const text = await runStatusOutput({ verbose: true });
    for (const token of [
      "OpenClaw status",
      "WhatsApp",
      "signal-cli unreachable",
      "Sessions",
      "50%",
      "40% cached",
      "40% hit",
      "read 2.0k",
      "legacy-plugin is hook-only",
      "Skipped in fast status",
    ]) {
      expect(text).toContain(token);
    }
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("uses prompt-side denominators for legacy cached sessions", async () => {
    for (const [inputTokens, cacheRead, cacheWrite, totalTokens, expected, forbidden] of [
      [undefined, 1200, 0, 1000, "100% cached", "120% cached"],
      [500, 2000, 500, 5000, "67% cached", "40% cached"],
    ] as const) {
      setScan({
        summary: {
          ...currentScan.summary,
          sessions: {
            ...currentScan.summary.sessions,
            recent: currentScan.summary.sessions.recent.map((row) =>
              Object.assign({}, row, { inputTokens, cacheRead, cacheWrite, totalTokens }),
            ),
          },
        },
      });
      const text = await runStatusOutput();
      expect(text).toContain(expected);
      expect(text).not.toContain(forbidden);
    }
  });

  it("shows node-only gateway info when no local gateway service is installed", async () => {
    mocks.gatewayService.mockResolvedValue({
      ...baseStatusServices.gatewayService,
      installed: false,
    });
    mocks.nodeConfig.mockResolvedValue({
      version: 1,
      nodeId: "node-1",
      gateway: { host: "gateway.example.com", port: 19000 },
    });
    const text = await runStatusOutput();
    expect(text).toContain("node → gateway.example.com:19000 · no local gateway");
    expect(text).toContain("openclaw --profile isolated node status");
    expect(text).not.toContain("Gateway: local · ws://127.0.0.1:18789");
    expect(text).not.toContain("Fix reachability first");
  });

  it("reports unresolved gateway auth in JSON without crashing", async () => {
    setScan({
      gatewayProbeAuthWarning: "gateway.auth.token unavailable",
      secretDiagnostics: ["gateway.auth.token unavailable"],
    });
    const payload = JSON.parse(await runStatusOutput({ json: true }));
    expect(payload.gateway.authWarning).toBe("gateway.auth.token unavailable");
    expect(payload.secretDiagnostics).toContain("gateway.auth.token unavailable");
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  });

  it("distinguishes service-wrapper secret diagnostics from the CLI context", async () => {
    const wrapperPath = "/usr/local/bin/openclaw-doppler";
    mocks.gatewayService.mockResolvedValue({ ...baseStatusServices.gatewayService, wrapperPath });
    setScan({ secretDiagnostics: ["gateway.auth.token unavailable"] });
    vi.stubEnv("OPENCLAW_WRAPPER", undefined);
    const text = await runStatusOutput();
    expect(text).toContain("Secret diagnostics:");
    expect(text).toContain("installed gateway service uses OPENCLAW_WRAPPER");
    expect(text).toContain("current CLI process rather than the installed gateway service");
    vi.stubEnv("OPENCLAW_WRAPPER", wrapperPath);
    const wrapped = await runStatusOutput();
    expect(wrapped).toContain("Secret diagnostics:");
    expect(wrapped).not.toContain("not running with that same wrapper");
  });

  it.each([
    {
      name: "unsafe legacy request",
      probe: { error: "pairing required (requestId: req-123;rm -rf /)" },
      expected: ["Gateway pairing approval required.", "Reason: device is not approved yet."],
    },
    {
      name: "request in close reason",
      probe: {
        error: "connect failed: pairing required",
        close: { code: 1008, reason: "pairing required (requestId: req-close-456)" },
      },
      expected: [
        "Gateway pairing approval required.",
        "Reason: device is not approved yet.",
        "Recovery: openclaw --profile isolated devices approve req-close-456",
      ],
    },
    {
      name: "structured request",
      probe: {
        connectErrorDetails: {
          code: "PAIRING_REQUIRED",
          reason: "scope-upgrade",
          requestId: "req-structured-789",
          remediationHint: "Review the requested scopes.",
        },
      },
      expected: [
        "Gateway scope upgrade approval required.",
        "Reason: device is asking for more scopes than currently approved.",
        "Hint: Review the requested scopes.",
        "Recovery: openclaw --profile isolated devices approve req-structured-789",
      ],
    },
    {
      name: "unsafe structured request and terminal hint",
      probe: {
        connectErrorDetails: {
          code: "PAIRING_REQUIRED",
          reason: "scope-upgrade",
          requestId: "req-structured-789;rm -rf /",
          remediationHint: "\u001b[31mReview\nfirst\u001b[0m",
        },
      },
      expected: [
        "Gateway scope upgrade approval required.",
        "Reason: device is asking for more scopes than currently approved.",
        "Hint: Review\\nfirst",
      ],
    },
  ])("prints safe pairing recovery from $name", async ({ probe, expected }) => {
    setScan({
      gatewayProbe: {
        ...createUnreachableGatewayProbe("ws://127.0.0.1:18789", "timeout"),
        ...probe,
      },
    });
    const text = await runStatusOutput();
    expect(text).not.toContain("\u001b[31mReview");
    const recovery = stripAnsi(text)
      .split("\n")
      .filter((line) =>
        /^(Gateway .*approval required\.|Reason: |Hint: |Recovery: |Fallback: |Inspect: )/.test(
          line,
        ),
      );
    expect(recovery).toEqual([
      ...expected,
      "Fallback: openclaw --profile isolated devices approve --latest",
      "Inspect: openclaw --profile isolated devices list",
    ]);
  });
});
