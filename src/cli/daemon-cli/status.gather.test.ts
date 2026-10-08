// Daemon status gather tests cover service status collection from platform state.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { REDACTED_SENTINEL } from "../../config/redact-sentinel.js";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import type { ForeignLaunchdJob } from "../../daemon/launchd-foreign-jobs.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { readSystemdServiceExecStart } from "../../daemon/systemd-service-files.js";
import { gatewayEdgeAuthValueForTarget } from "../../gateway/edge-auth.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { GatewayRestartHandoff } from "../../infra/restart-handoff.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OpenClawDatabaseSchemaPreflightError } from "../../state/openclaw-database-preflight.messages.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import { registerGatewayCli } from "../gateway-cli/register.js";
import { registerDaemonCli } from "./register.js";
import type { GatewayRestartSnapshot } from "./restart-health.js";
import { registerStatusConfigReadTests } from "./status.gather.config.test-support.js";
import { gatherDaemonStatus } from "./status.gather.js";
import {
  callGatewayStatusProbe,
  capturePrintedDaemonStatus,
  findExtraGatewayServices,
  findForeignLaunchdJobs,
  findStaleOpenClawUpdateLaunchdJobs,
  formatPortDiagnostics,
  inspectGatewayTlsCertificate,
  inspectPortConnections,
  inspectPortUsage,
  inspectPortUsages,
  readLastGatewayErrorLine,
  type GatewayStatusProbeOptions,
  type PortUsageInspectionOptions,
  type PortUsageTestSummary,
} from "./status.gather.probes.test-support.js";
import { registerServiceInspectionStatusTests } from "./status.gather.service-inspection.test-support.js";
import { registerStatusTimeoutTests } from "./status.gather.timeout.test-support.js";

const readFile = fs.readFile.bind(fs);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let readFileSpy: ReturnType<typeof vi.spyOn>;
const serviceFixture = vi.hoisted(() => ({ label: "LaunchAgent", useSystemdCommand: false }));

const preflightOpenClawDatabaseSchemas = vi.fn<
  typeof import("../../state/openclaw-database-preflight.js").preflightOpenClawDatabaseSchemas
>(async () => ({ incompatible: [], indeterminate: [] }));

const isDefaultInstallIdentity = vi.fn((_env?: NodeJS.ProcessEnv) => true);
const isGatewayExternallySupervised = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const resolveGatewayProbeAuthSafeWithSecretInputsCalls = vi.fn<(opts?: unknown) => void>();
const loadInstalledPluginIndexInstallRecords = vi.fn<
  (params?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    filePath?: string;
  }) => Promise<Record<string, unknown>>
>(async (_params?) => ({}));
const fetchNpmPackageTargetStatus = vi.fn(
  async (params: { packageName?: string; target: string }) => ({
    version: params.target,
    nodeEngine: null,
  }),
);
const readGatewayRestartHandoffSync = vi.fn<
  (_env?: NodeJS.ProcessEnv) => GatewayRestartHandoff | null
>(() => null);
const readGatewayLastShutdown = vi.fn<
  (_env?: NodeJS.ProcessEnv) => { reason: string | null; completedAtMs: number } | undefined
>(() => undefined);
const findSystemdGatewayInstallation = vi.fn<
  typeof import("../../daemon/systemd-scope.js").findSystemdGatewayInstallation
>(async () => ({ kind: "none" }));
const inspectWindowsGatewayFirewall = vi.fn<(opts?: unknown) => Promise<unknown>>(async () => ({
  applies: false,
  severity: "info" as const,
  code: "windows_firewall_not_applicable",
  message: "Windows LAN firewall diagnostics do not apply.",
  details: [],
}));
const auditGatewayServiceConfig = vi.fn<(_opts?: unknown) => Promise<ServiceConfigAudit>>(
  async () => ({ ok: true, issues: [] }),
);
const serviceIsLoaded = vi.fn<
  (opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<boolean>
>(async (_opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => true);
const serviceReadRuntime = vi.fn<
  (_env?: NodeJS.ProcessEnv, _opts?: { timeoutMs?: number }) => Promise<GatewayServiceRuntime>
>(async (_env?: NodeJS.ProcessEnv, _opts?: { timeoutMs?: number }) => ({ status: "running" }));
const inspectGatewayRestart = vi.fn<(opts?: unknown) => Promise<GatewayRestartSnapshot>>(
  async (_opts?: unknown) => ({
    runtime: { status: "running", pid: 1234 },
    portUsage: { port: 19001, status: "busy", listeners: [], hints: [] },
    healthy: true,
    staleGatewayPids: [],
  }),
);
const daemonEnvironment = {
  OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
  OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
};
function serviceCommand(environment: Record<string, string> = daemonEnvironment) {
  return {
    programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
    environment,
  };
}
const serviceReadCommand = vi.fn<
  (
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ programArguments: string[]; environment?: Record<string, string> } | null>
>(async () => serviceCommand());

const resolveGatewayBindHost = vi.fn(
  async (_bindMode?: string, _customBindHost?: string) => "0.0.0.0",
);
const resolveAdvertisedControlUiLinks = vi.fn(async (_opts?: unknown) => ({
  httpUrl: "https://10.211.55.3:19001/",
  wsUrl: "wss://10.211.55.3:19001",
}));
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.9");
const resolveGatewayPort = vi.fn((_cfg?: unknown, _env?: unknown) => 18789);
const resolveStateDir = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-cli",
);
const resolveConfigPath = vi.fn((env: NodeJS.ProcessEnv, stateDir: string) => {
  return env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`;
});
const createConfigIOCalls = vi.fn(
  (configPath: string, pluginValidation?: "full" | "skip", observe?: boolean) => ({
    configPath,
    pluginValidation,
    observe,
  }),
);
const readConfigFileSnapshotCalls = vi.fn((configPath: string) => configPath);
const loadConfigCalls = vi.fn((configPath: string) => configPath);
let daemonConfigWarnings: Array<{ path: string; message: string }> = [];
let cliConfigWarnings: Array<{ path: string; message: string }> = [];
let configIssues: Array<{ path: string; message: string }> = [];
let daemonLoadedConfig: Record<string, unknown> = {
  gateway: {
    bind: "lan",
    tls: { enabled: true },
    auth: { token: "daemon-token" },
  },
};
let cliLoadedConfig: Record<string, unknown> = {
  gateway: {
    bind: "loopback",
  },
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => cliLoadedConfig,
  loadConfig: () => cliLoadedConfig,
}));

vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  isDefaultInstallIdentity: (env?: NodeJS.ProcessEnv) => isDefaultInstallIdentity(env),
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
  resolveStateDir: (env: NodeJS.ProcessEnv) => resolveStateDir(env),
}));

vi.mock("../../config/io.runtime.js", () => ({
  createConfigIO: ({
    configPath,
    observe,
    pluginValidation,
  }: {
    configPath: string;
    observe?: boolean;
    pluginValidation?: "full" | "skip";
  }) => {
    const isDaemon = configPath.includes("/openclaw-daemon/");
    const runtimeConfig = isDaemon ? daemonLoadedConfig : cliLoadedConfig;
    const warnings = isDaemon ? daemonConfigWarnings : cliConfigWarnings;
    createConfigIOCalls(configPath, pluginValidation, observe);
    return {
      readConfigFileSnapshot: async () => {
        readConfigFileSnapshotCalls(configPath);
        return {
          path: configPath,
          exists: true,
          valid: configIssues.length === 0,
          issues: configIssues,
          warnings: pluginValidation === "full" ? warnings : [],
          runtimeConfig,
          config: runtimeConfig,
        };
      },
      loadConfig: () => {
        loadConfigCalls(configPath);
        if (configIssues.length > 0) {
          throw new Error("Invalid config");
        }
        return runtimeConfig;
      },
    };
  },
}));

vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: (env: NodeJS.ProcessEnv, options?: { requirePatternMatch?: boolean }) =>
    readLastGatewayErrorLine(env, options),
}));

vi.mock("../../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
}));

vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  readGatewayLastShutdown: (env?: NodeJS.ProcessEnv) => readGatewayLastShutdown(env),
}));

vi.mock("../../state/openclaw-database-preflight.js", () => ({
  OpenClawDatabaseSchemaPreflightError,
  preflightOpenClawDatabaseSchemas: (
    options: Parameters<typeof preflightOpenClawDatabaseSchemas>[0],
  ) => preflightOpenClawDatabaseSchemas(options),
}));

vi.mock("../../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-scope.js")>()),
  findSystemdGatewayInstallation: (env: NodeJS.ProcessEnv) => findSystemdGatewayInstallation(env),
}));

vi.mock("../../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd.js")>()),
  findStaleOpenClawUpdateLaunchdJobs: (env?: NodeJS.ProcessEnv) =>
    findStaleOpenClawUpdateLaunchdJobs(env),
}));

vi.mock("../../daemon/launchd-foreign-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-foreign-jobs.js")>()),
  findForeignLaunchdJobs: (env?: NodeJS.ProcessEnv) => findForeignLaunchdJobs(env),
}));

vi.mock("../../daemon/restart-storm.js", () => ({
  readGatewayForcedRestartSummary: () => ({ count: 3, windowMs: 600_000 }),
}));

vi.mock("../../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: (opts: unknown) => auditGatewayServiceConfig(opts),
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () =>
    createMockGatewayService({
      label: serviceFixture.label,
      isLoaded: serviceIsLoaded,
      readCommand: serviceFixture.useSystemdCommand
        ? readSystemdServiceExecStart
        : serviceReadCommand,
      readRuntime: serviceReadRuntime,
    }),
}));

vi.mock("../../gateway/net.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/net.js")>()),
  resolveGatewayBindHost: (bindMode: string, customBindHost?: string) =>
    resolveGatewayBindHost(bindMode, customBindHost),
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(bindHost) && bindHost !== "0.0.0.0" && bindHost !== "127.0.0.1"
      ? [bindHost, "127.0.0.1"]
      : [bindHost],
}));

vi.mock("../../gateway/control-ui-links.js", () => ({
  resolveAdvertisedControlUiLinks: (opts?: unknown) => resolveAdvertisedControlUiLinks(opts),
}));

vi.mock("../../gateway/probe-auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGatewayProbeAuthSafeWithSecretInputs: async (opts: unknown) => {
      resolveGatewayProbeAuthSafeWithSecretInputsCalls(opts);
      return await (
        actual.resolveGatewayProbeAuthSafeWithSecretInputs as (opts: unknown) => Promise<unknown>
      )(opts);
    },
  };
});

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortConnections: (port: number) => inspectPortConnections(port),
  inspectPortUsage: (port: number, options?: PortUsageInspectionOptions) =>
    inspectPortUsage(port, options),
  inspectPortUsages: (
    ports: readonly number[],
    options?: { probeHostsByPort?: ReadonlyMap<number, readonly string[]> },
  ) => inspectPortUsages(ports, options),
}));

vi.mock("../../infra/ports-format.js", () => ({
  formatPortDiagnostics: (usage: PortUsageTestSummary) => formatPortDiagnostics(usage),
}));

vi.mock("../../infra/restart-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-handoff.js")>()),
  readGatewayRestartHandoffSync: (env?: NodeJS.ProcessEnv) => readGatewayRestartHandoffSync(env),
}));

vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  isGatewayExternallySupervised: (env?: NodeJS.ProcessEnv) => isGatewayExternallySupervised(env),
}));

vi.mock("../../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../../infra/tls/gateway.js", () => ({
  inspectGatewayTlsCertificate: (cfg: unknown) => inspectGatewayTlsCertificate(cfg),
}));

vi.mock("../../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: (opts: unknown) => inspectWindowsGatewayFirewall(opts),
}));

vi.mock("../../infra/update-check-package-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check-package-target.js")>()),
  fetchNpmPackageTargetStatus: (params: { packageName?: string; target: string }) =>
    fetchNpmPackageTargetStatus(params),
}));

vi.mock("./probe.js", () => ({
  probeGatewayStatus: (opts: GatewayStatusProbeOptions) => callGatewayStatusProbe(opts),
}));

vi.mock("../../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords: (params?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    filePath?: string;
  }) => loadInstalledPluginIndexInstallRecords(params),
}));

vi.mock("./restart-health.js", () => ({
  inspectGatewayRestart: (opts: unknown) => inspectGatewayRestart(opts),
}));

function callArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

function probeInput() {
  const input = callGatewayStatusProbe.mock.calls[0]?.[0];
  assert(input, "expected status probe");
  return input;
}

function gatherStatus(overrides: Partial<Parameters<typeof gatherDaemonStatus>[0]> = {}) {
  return gatherDaemonStatus({ rpc: {}, probe: true, deep: false, ...overrides });
}

async function withStatusConfig<T>(
  rawConfig: string | undefined,
  run: (configPath: string) => Promise<T>,
  includeServiceEnv = false,
): Promise<T> {
  const tmp = tempDirs.make("openclaw-status-config-");
  const configPath = path.join(tmp, "openclaw.json");
  if (rawConfig !== undefined) {
    await fs.writeFile(configPath, rawConfig);
  }
  setTestEnvValue("OPENCLAW_STATE_DIR", tmp);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  serviceReadCommand.mockResolvedValueOnce({
    programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
    ...(includeServiceEnv
      ? {
          environment: {
            OPENCLAW_STATE_DIR: tmp,
            OPENCLAW_CONFIG_PATH: configPath,
          },
        }
      : {}),
  });
  return await run(configPath);
}

describe("gatherDaemonStatus", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    serviceFixture.useSystemdCommand = false;
    readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (
        filePath === "/tmp/openclaw-cli/openclaw.json" ||
        filePath === "/tmp/openclaw-daemon/openclaw.json"
      ) {
        throw Object.assign(new Error("test config requires full IO"), { code: "EACCES" });
      }
      return await readFile(filePath, options);
    });
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_GATEWAY_URL",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "DAEMON_GATEWAY_TOKEN",
      "DAEMON_GATEWAY_PASSWORD",
    ]);
    setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-cli");
    setTestEnvValue("OPENCLAW_CONFIG_PATH", "/tmp/openclaw-cli/openclaw.json");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("DAEMON_GATEWAY_TOKEN");
    deleteTestEnvValue("DAEMON_GATEWAY_PASSWORD");
    isDefaultInstallIdentity.mockReset().mockReturnValue(true);
    isGatewayExternallySupervised.mockReset().mockReturnValue(false);
    auditGatewayServiceConfig.mockClear();
    callGatewayStatusProbe.mockClear();
    resolveAdvertisedControlUiLinks.mockClear();
    resolveAdvertisedControlUiLinks.mockResolvedValue({
      httpUrl: "https://10.211.55.3:19001/",
      wsUrl: "wss://10.211.55.3:19001",
    });
    resolveGatewayBindHost.mockClear();
    resolveGatewayBindHost.mockImplementation(async (bindMode?: string) =>
      bindMode === "loopback" ? "127.0.0.1" : "0.0.0.0",
    );
    resolveGatewayProbeAuthSafeWithSecretInputsCalls.mockClear();
    createConfigIOCalls.mockClear();
    findExtraGatewayServices.mockReset().mockResolvedValue({ services: [], errors: [] });
    findStaleOpenClawUpdateLaunchdJobs.mockReset();
    findStaleOpenClawUpdateLaunchdJobs.mockResolvedValue([]);
    findForeignLaunchdJobs.mockReset().mockResolvedValue([]);
    loadInstalledPluginIndexInstallRecords.mockClear();
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    fetchNpmPackageTargetStatus.mockClear();
    fetchNpmPackageTargetStatus.mockImplementation(async (params) => ({
      version: params.target,
      nodeEngine: null,
    }));
    inspectGatewayTlsCertificate.mockClear();
    inspectGatewayRestart.mockClear();
    inspectPortUsage.mockReset();
    inspectPortUsage.mockImplementation(async (port: number) => ({
      port,
      status: "free" as const,
      listeners: [],
      hints: [],
    }));
    inspectPortUsages.mockReset();
    inspectPortUsages.mockImplementation(async (ports: readonly number[]) => {
      return new Map(
        ports.map((port) => [
          port,
          {
            port,
            status: "free" as const,
            listeners: [],
            hints: [],
          },
        ]),
      );
    });
    inspectPortConnections.mockClear();
    formatPortDiagnostics.mockReset().mockReturnValue(["port diagnostics"]);
    inspectWindowsGatewayFirewall.mockClear();
    inspectWindowsGatewayFirewall.mockResolvedValue({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    });
    readLastGatewayErrorLine.mockReset();
    readLastGatewayErrorLine.mockResolvedValue(null);
    readGatewayRestartHandoffSync.mockClear();
    readGatewayLastShutdown.mockReset().mockReturnValue(undefined);
    preflightOpenClawDatabaseSchemas
      .mockReset()
      .mockResolvedValue({ incompatible: [], indeterminate: [] });
    findSystemdGatewayInstallation.mockReset().mockResolvedValue({ kind: "none" });
    serviceIsLoaded.mockClear();
    serviceReadCommand.mockClear();
    serviceReadRuntime.mockClear();
    readConfigFileSnapshotCalls.mockClear();
    loadConfigCalls.mockClear();
    daemonConfigWarnings = [];
    cliConfigWarnings = [];
    configIssues = [];
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: { token: "daemon-token" },
      },
    };
    cliLoadedConfig = {
      gateway: {
        bind: "loopback",
      },
    };
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    envSnapshot.restore();
  });

  it("excludes only the observed systemd unit and scope", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    serviceFixture.label = "systemd";
    const userService: ExtraGatewayService = {
      platform: "linux",
      label: "openclaw.service",
      scope: "user",
      detail: "unit: /home/test/.config/systemd/user/openclaw.service",
    };
    const systemService: ExtraGatewayService = {
      platform: "linux",
      label: "openclaw.service",
      scope: "system",
      detail: "unit: /etc/systemd/system/openclaw.service",
    };
    const otherService: ExtraGatewayService = {
      ...systemService,
      label: "openclaw-rescue.service",
      detail: "unit: /etc/systemd/system/openclaw-rescue.service",
    };
    findExtraGatewayServices.mockResolvedValueOnce({
      services: [userService, systemService, otherService],
      errors: [
        {
          source: "/etc/systemd/system/openclaw-unreadable.service",
          message: "Service path could not be inspected.",
        },
      ],
    });
    serviceReadRuntime.mockResolvedValueOnce({
      status: "running",
      systemd: { unit: "openclaw.service", scope: "system" },
    });

    try {
      const status = await gatherStatus({ probe: false, deep: true });

      expect(status.extraServices).toEqual([userService, otherService]);
      expect(status.service.label).toBe("systemd system");
    } finally {
      serviceFixture.label = "LaunchAgent";
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("uses wss probe URL and forwards TLS fingerprint when daemon TLS is enabled", async () => {
    const status = await gatherStatus();

    expect(inspectGatewayTlsCertificate).toHaveBeenCalledTimes(1);
    const input = probeInput();
    expect(input.url).toBe("wss://127.0.0.1:19001");
    expect(input.tlsFingerprint).toBe("sha256:11:22:33:44");
    expect(input.token).toBe("daemon-token");
    expect(status.gateway?.probeUrl).toBe("wss://127.0.0.1:19001");
    expect(status.gateway?.controlUiLinks).toEqual({
      httpUrl: "https://10.211.55.3:19001/",
      wsUrl: "wss://10.211.55.3:19001",
    });
    expect(status.gateway?.tlsEnabled).toBe(true);
    expect(status.gateway?.version).toBe("2026.5.6");
    expect(status.rpc?.url).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.ok).toBe(true);
    expect(status.rpc?.server).toEqual({
      version: "2026.5.6",
      buildId: "build-2026.5.6",
      connId: "conn-1",
    });
    expect(status.cli?.version).toBe(VERSION);
    if (process.argv[1]) {
      expect(status.cli?.entrypoint).toBe(process.argv[1]);
    }
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
    expect(inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    const output = capturePrintedDaemonStatus(status, { json: false });
    expect(output.logs).toContain("Dashboard: https://10.211.55.3:19001/");
    expect(output.logs).toContain(`CLI version: ${VERSION}`);
    expect(output.logs).toContain("Gateway version: 2026.5.6");
    expect(output.errors).toContain("update PATH so `openclaw` points to the version you want");
  });

  it.each(
    [
      ["environment", undefined],
      ["none", "wss://remote.example:19443"],
      ["configured", "wss://127.0.0.1:19001/other"],
    ].map(([auth, remoteUrl], index) => ({ auth, remoteUrl, requireRpc: index % 2 === 1 })),
  )(
    "uses service $auth credentials with remote=$remoteUrl and requireRpc=$requireRpc",
    async ({ auth, remoteUrl, requireRpc }) => {
      const edgeAuth = { "X-Test-Edge-Auth": "synthetic-status-edge-auth" };
      daemonLoadedConfig = {
        gateway: {
          mode: "remote",
          bind: "loopback",
          tls: { enabled: true },
          auth:
            auth === "none"
              ? { mode: "none" }
              : {
                  mode: "token",
                  ...(auth === "configured"
                    ? { token: "service-config-token", password: "local-password" }
                    : {}),
                },
          remote: {
            url: remoteUrl,
            edgeAuth,
            token: { source: "exec", provider: "vault", id: "gateway/remote-token" },
            password: "remote-password",
            tlsFingerprint: "sha256:99:88:77:66",
          },
        },
      };
      daemonLoadedConfig.secrets = {
        providers: { vault: { source: "exec", command: "/bin/false" } },
      };
      const originalConfig = structuredClone(daemonLoadedConfig);
      serviceReadCommand.mockResolvedValueOnce(
        serviceCommand({
          ...daemonEnvironment,
          OPENCLAW_GATEWAY_TOKEN: "service-env-token",
        }),
      );
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "ambient-token");
      setTestEnvValue("OPENCLAW_GATEWAY_URL", "wss://ambient.example:19444");

      const status = await gatherStatus({ requireRpc, allowExecSecretRefs: false });
      const input = probeInput();

      expect(input.url).toBe("wss://127.0.0.1:19001");
      expect(input.urlOverride).toBeUndefined();
      expect(input.token).toBe(
        auth === "none"
          ? undefined
          : auth === "configured"
            ? "service-config-token"
            : "service-env-token",
      );
      expect(input.password).toBe(auth === "configured" ? "local-password" : undefined);
      expect(input.tlsFingerprint).toBe("sha256:11:22:33:44");
      expect(input.requireRpc).toBe(requireRpc);
      assert(input.config);
      expect(gatewayEdgeAuthValueForTarget({ config: input.config, targetUrl: input.url })).toEqual(
        remoteUrl === "wss://127.0.0.1:19001" ? edgeAuth : undefined,
      );
      expect(input.config.gateway?.mode).toBe("local");
      expect(input.config.gateway?.remote).toEqual({
        url: remoteUrl,
        edgeAuth,
        tlsFingerprint: "sha256:99:88:77:66",
      });
      expect(input.config.gateway?.auth).toEqual({ mode: auth === "none" ? "none" : "token" });
      expect(input.config.gateway?.tls).toBeUndefined();
      expect(status.rpc?.url).toBe(input.url);
      expect(daemonLoadedConfig).toEqual(originalConfig);
    },
  );

  it.each(
    [
      { auth: {}, remoteUrl: "wss://explicit.example:19445" },
      { auth: { password: "explicit-password" }, remoteUrl: "wss://explicit.example:19445" },
    ].map(({ auth, remoteUrl }, index) => ({ auth, remoteUrl, requireRpc: index % 2 === 1 })),
  )(
    "isolates explicit status credentials $auth with remote=$remoteUrl and requireRpc=$requireRpc",
    async ({ auth, remoteUrl, requireRpc }) => {
      const edgeAuth = { "X-Test-Edge-Auth": "synthetic-status-edge-auth" };
      daemonLoadedConfig = {
        gateway: {
          mode: "remote",
          tls: { enabled: true },
          auth: {
            mode: "token",
            token: { source: "exec", provider: "vault", id: "gateway/token" },
          },
          remote: {
            url: remoteUrl,
            edgeAuth,
            token: "remote-token",
            password: "remote-password",
            tlsFingerprint: "sha256:99:88:77:66",
          },
        },
      };
      daemonLoadedConfig.secrets = {
        providers: { vault: { source: "exec", command: "/bin/false" } },
      };
      const originalConfig = structuredClone(daemonLoadedConfig);
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "ambient-token");
      const status = await gatherStatus({
        rpc: { url: "wss://explicit.example:19445", ...auth },
        allowExecSecretRefs: false,
        requireRpc,
      });

      const input = probeInput();
      expect(input).toMatchObject({
        url: "wss://explicit.example:19445",
        urlOverride: "wss://explicit.example:19445",
        ...auth,
      });
      expect({ token: input.token, password: input.password }).toEqual(auth);
      expect(input.tlsFingerprint).toBeUndefined();
      expect(input.requireRpc).toBe(requireRpc);
      assert(input.config);
      expect(gatewayEdgeAuthValueForTarget({ config: input.config, targetUrl: input.url })).toEqual(
        remoteUrl === input.url ? edgeAuth : undefined,
      );
      expect(input.config.gateway?.mode).toBe("local");
      expect(input.config.gateway?.remote).toEqual({
        url: remoteUrl,
        edgeAuth,
        tlsFingerprint: "sha256:99:88:77:66",
      });
      expect(input.config.gateway?.auth).toBeUndefined();
      expect(input.config.gateway?.tls).toBeUndefined();
      expect(status.rpc?.authWarning).toBeUndefined();
      expect(inspectGatewayTlsCertificate).not.toHaveBeenCalled();
      expect(resolveGatewayProbeAuthSafeWithSecretInputsCalls).not.toHaveBeenCalled();
      expect(daemonLoadedConfig).toEqual(originalConfig);
    },
  );

  it.each([
    { name: "matching", pinMatches: true },
    { name: "mismatched", pinMatches: false },
  ])("enforces a $name saved TLS pin before explicit status traffic", async ({ pinMatches }) => {
    const actualProbe = await vi.importActual<typeof import("./probe.js")>("./probe.js");
    const originalProbe = callGatewayStatusProbe.getMockImplementation();
    assert(originalProbe);
    const server = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
    const sockets = new Set<Socket>();
    const closedSockets: Promise<void>[] = [];
    const edgeAuthHeaders: unknown[] = [];
    const connectTokens: Array<string | undefined> = [];
    const edgeAuthValue = "synthetic-status-edge-auth";
    const explicitToken = "synthetic-explicit-status-token";
    let receivedBytes = 0;
    let upgrades = 0;
    server.on("connection", (socket) => {
      sockets.add(socket);
      closedSockets.push(
        new Promise<void>((resolve) => {
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          });
        }),
      );
    });
    server.on("secureConnection", (socket) => {
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
      });
    });
    server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      edgeAuthHeaders.push(request.headers["x-test-edge-auth"]);
      if (request.headers["x-test-edge-auth"] !== edgeAuthValue) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
    wss.on("connection", (ws) => {
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (raw) => {
        const frame = parseMinimalGatewayRequestFrame(raw);
        if (frame.type !== "req" || frame.method !== "connect" || !frame.id) {
          return;
        }
        connectTokens.push(frame.params?.auth?.token);
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            auth: { role: "operator", scopes: ["operator.read"] },
          }),
        );
      });
    });
    callGatewayStatusProbe.mockImplementation(actualProbe.probeGatewayStatus);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address !== "string");
      const url = `wss://127.0.0.1:${address.port}/gateway`;
      const savedPin = pinMatches
        ? new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256
        : "00".repeat(32);
      await withStatusConfig(
        JSON.stringify({
          gateway: {
            mode: "remote",
            tls: { enabled: true },
            auth: { mode: "token", token: "unrelated-service-token" },
            remote: {
              url,
              token: "unrelated-remote-token",
              password: "unrelated-remote-password",
              tlsFingerprint: savedPin,
              edgeAuth: { "X-Test-Edge-Auth": edgeAuthValue },
            },
          },
        }),
        async () => {
          const status = await gatherStatus({
            rpc: { url, token: explicitToken, json: true, timeout: "2000" },
            requireRpc: false,
          });
          await Promise.all(closedSockets);
          const input = callGatewayStatusProbe.mock.calls[0]?.[0];
          assert(input);
          expect(input.tlsFingerprint).toBeUndefined();
          expect(input.config?.gateway?.remote).toEqual({
            url,
            edgeAuth: { "X-Test-Edge-Auth": edgeAuthValue },
            tlsFingerprint: savedPin,
          });
          expect(input.config?.gateway?.tls).toBeUndefined();
          expect(inspectGatewayTlsCertificate).not.toHaveBeenCalled();
          expect(status.rpc?.ok, status.rpc?.error).toBe(pinMatches);
          if (pinMatches) {
            expect(receivedBytes).toBeGreaterThan(0);
            expect(upgrades).toBe(1);
            expect(edgeAuthHeaders).toEqual([edgeAuthValue]);
            expect(connectTokens).toEqual([explicitToken]);
          } else {
            expect(status.rpc?.error).toMatch(/fingerprint mismatch/i);
            expect(receivedBytes).toBe(0);
            expect(upgrades).toBe(0);
            expect(edgeAuthHeaders).toEqual([]);
            expect(connectTokens).toEqual([]);
          }
        },
        true,
      );
    } finally {
      callGatewayStatusProbe.mockImplementation(originalProbe);
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeMinimalGatewayServer(wss);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      resetSecretRedactionRegistryForTest();
    }
  });

  it.each(
    [
      ["gateway", "--port", "19003", "status", "--port", "19002"],
      ["daemon", "status", "--port", "19002"],
    ].map((argv) => ({ name: argv.join(" "), argv })),
  )("targets the selected local port for $name", async ({ argv }) => {
    const program = new Command().enablePositionalOptions().exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerGatewayCli(program);
    registerDaemonCli(program);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    try {
      await program.parseAsync([...argv, "--json"], { from: "user" });

      expect(callGatewayStatusProbe).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "ws://127.0.0.1:19002",
          localPortOverride: 19002,
          config: {
            gateway: {
              bind: "loopback",
              mode: "local",
              remote: undefined,
              auth: undefined,
              tls: undefined,
            },
          },
          configPath: "/tmp/openclaw-cli/openclaw.json",
        }),
      );
      expect(writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          gateway: expect.objectContaining({
            port: 19002,
            portSource: "cli",
            probeUrl: "ws://127.0.0.1:19002",
          }),
          rpc: expect.objectContaining({ url: "ws://127.0.0.1:19002" }),
          service: expect.objectContaining({ targetRole: "diagnostic-only" }),
        }),
      );
    } finally {
      writeJson.mockRestore();
    }
  });

  it.each([true, false])(
    "keeps an explicit local port in remote config with probe=%s",
    async (probe) => {
      cliLoadedConfig = {
        gateway: {
          mode: "remote",
          bind: "tailnet",
          tls: { enabled: true },
          auth: { token: "local-token" },
          remote: { url: "wss://gateway.example", token: "remote-token" },
        },
      };
      const status = await gatherStatus({ rpc: { localPortOverride: 19002 }, probe, deep: true });

      expect(status.gateway).toMatchObject({
        port: 19002,
        portSource: "cli",
        probeUrl: "wss://127.0.0.1:19002",
      });
      expect(inspectPortConnections).toHaveBeenCalledWith(19002);
      expect(status.service.targetRole).toBe("diagnostic-only");
      expect(findSystemdGatewayInstallation).not.toHaveBeenCalled();
      expect(inspectGatewayRestart).not.toHaveBeenCalled();
      if (probe) {
        expect(callGatewayStatusProbe).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "wss://127.0.0.1:19002",
            token: "local-token",
            tlsFingerprint: "sha256:11:22:33:44",
          }),
        );
      } else {
        expect(callGatewayStatusProbe).not.toHaveBeenCalled();
        expect(status.rpc).toBeUndefined();
      }
    },
  );

  it.each([
    { rpc: { port: "65536" }, message: "--port must be an integer between 1 and 65535." },
    {
      rpc: { port: "19002", url: "ws://localhost:19002" },
      message: "Use either --url or --port, not both.",
    },
  ])("rejects invalid status target $rpc before service reads", async ({ rpc, message }) => {
    await expect(gatherStatus({ rpc })).rejects.toThrow(message);
    expect(serviceReadCommand).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).not.toHaveBeenCalled();
  });

  it("reports the heap limit from the installed Gateway service", async () => {
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "--max-heap-size=8192", "cli", "gateway", "--port", "19001"],
      environment: {
        ...daemonEnvironment,
        NODE_OPTIONS: "--max-old-space-size=6144",
      },
    });

    const status = await gatherStatus({ probe: false });

    expect(status.service.gatewayHeap).toMatchObject({
      nodeOptions: "--max-old-space-size=6144",
      execArgv: ["--max-heap-size=8192"],
    });
    expect(status.service.gatewayHeap?.memorySource).toMatch(/^(constrained|physical)$/u);
    const output = capturePrintedDaemonStatus(status, { json: false }).logs;
    expect(output).toContain("Gateway heap: service NODE_OPTIONS: --max-old-space-size=6144");
    expect(output).toContain("installer recommendation:");
    expect(output).toContain("runtime V8 ceiling: not measured");
  });

  it("includes Windows firewall diagnostics during deep LAN gateway status", async () => {
    inspectWindowsGatewayFirewall.mockResolvedValueOnce({
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
      message: "Windows Firewall may ignore local Gateway allow rules for this network profile.",
      details: ["Windows reports LocalFirewallRules as N/A (GPO-store only)."],
    });

    const status = await gatherStatus({ probe: false, deep: true });

    expect(inspectWindowsGatewayFirewall).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", mode: "quick", port: 19001 }),
    );
    expect(status.gateway?.windowsFirewall).toMatchObject({
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
    });
    const output = capturePrintedDaemonStatus(status, { json: false, deep: true }).errors;
    expect(output).toContain("Windows firewall: Windows Firewall may ignore");
    expect(output).toContain("GPO-store only");
  });

  it("falls back to probe version when server metadata is unavailable", async () => {
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:19001",
      error: null,
      version: "2026.5.7",
    });

    const status = await gatherStatus();

    expect(status.gateway?.version).toBe("2026.5.7");
    expect(status.rpc?.version).toBe("2026.5.7");
    expect(status.rpc?.server).toBeUndefined();
    const output = capturePrintedDaemonStatus(status, { json: false });
    expect(output.logs).toContain("Gateway version: 2026.5.7");
    expect(output.errors).toContain(`this OpenClaw command is version ${VERSION}`);
  });

  it("uses raw explicit URLs for probes but redacts them from status diagnostics", async () => {
    const rawUrl =
      "wss://user:password@override.example:18790/ws?token=secret&key=api-key&X-Amz-Signature=signed";
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: rawUrl,
      error: "connect ECONNREFUSED override.example:18790",
    });

    const status = await gatherStatus({ rpc: { url: rawUrl } });

    expect(inspectGatewayTlsCertificate).not.toHaveBeenCalled();
    const input = probeInput();
    expect(input.url).toBe(rawUrl);
    expect(input.tlsFingerprint).toBeUndefined();
    const diagnosticUrls = JSON.stringify({
      gateway: status.gateway?.probeUrl,
      rpc: status.rpc?.url,
    });
    expect(diagnosticUrls).toContain("override.example:18790/ws");
    expect(diagnosticUrls).not.toContain("user");
    expect(diagnosticUrls).not.toContain("password");
    expect(diagnosticUrls).not.toContain("secret");
    expect(diagnosticUrls).not.toContain("api-key");
    expect(diagnosticUrls).not.toContain("signed");
    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(status.pluginVersionDrift).toBeUndefined();
    expect(status.service.targetRole).toBe("diagnostic-only");
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
  });

  it.each([
    ["non-default install identity", false, false],
    ["external supervisor", true, true],
  ])(
    "uses the active %s context instead of an unrelated native service",
    async (_, isDefault, external) => {
      setTestEnvValue("OPENCLAW_GATEWAY_PORT", "18900");
      isDefaultInstallIdentity.mockReturnValue(isDefault);
      isGatewayExternallySupervised.mockReturnValue(external);
      serviceReadCommand.mockResolvedValueOnce({
        programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_CONFIG_PATH: "/tmp/legacy-openclaw/openclaw.json",
          OPENCLAW_STATE_DIR: "/tmp/legacy-openclaw",
        },
      });
      resolveGatewayPort.mockImplementation((_cfg?: unknown, env?: unknown) =>
        Number((env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_GATEWAY_PORT ?? 18789),
      );
      callGatewayStatusProbe.mockResolvedValueOnce({
        ok: false,
        url: "ws://127.0.0.1:18900",
        error: "connect ECONNREFUSED 127.0.0.1:18900",
      });
      loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
        whatsapp: {
          source: "npm",
          resolvedName: "@openclaw/whatsapp",
          resolvedVersion: "2026.5.4",
        },
      } as never);

      const status = await gatherStatus({
        requireRpc: true,
        deep: true,
        pluginVersionTarget: "restart",
      });

      expect(status.gateway?.probeUrl).toBe("ws://127.0.0.1:18900");
      expect(probeInput().url).toBe("ws://127.0.0.1:18900");
      const input = probeInput();
      expect(input.config).toEqual({
        ...cliLoadedConfig,
        gateway: {
          bind: "loopback",
          mode: "local",
          auth: undefined,
          remote: undefined,
          tls: undefined,
        },
      });
      expect(input.configPath).toBe("/tmp/openclaw-cli/openclaw.json");
      const authInput = callArg(resolveGatewayProbeAuthSafeWithSecretInputsCalls) as {
        cfg?: unknown;
        env?: NodeJS.ProcessEnv;
      };
      expect(authInput.cfg).toBe(cliLoadedConfig);
      expect(authInput.env?.OPENCLAW_GATEWAY_PORT).toBe("18900");
      expect(status.service.targetRole).toBe("diagnostic-only");
      expect(status.pluginVersionRestartReadiness).toBeUndefined();
      expect(inspectGatewayRestart).not.toHaveBeenCalled();
    },
  );

  it("uses fallback network details when interface discovery throws during status inspection", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "tailnet",
        tls: { enabled: true },
        auth: { token: "daemon-token" },
      },
    };
    resolveGatewayBindHost.mockImplementationOnce(async () => {
      throw new Error("uv_interface_addresses failed");
    });
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const status = await gatherStatus();

    expect(status.gateway?.bindMode).toBe("tailnet");
    expect(status.gateway?.bindHost).toBe("127.0.0.1");
    expect(status.gateway?.probeUrl).toBe("wss://127.0.0.1:19001");
    expect(status.gateway?.probeNote).toContain("interface discovery failed");
    expect(status.gateway?.probeNote).toContain("tailnet addresses");
  });

  it("retains service audit findings when the active command is absent", async () => {
    serviceReadCommand.mockResolvedValueOnce(null);
    auditGatewayServiceConfig.mockResolvedValueOnce({
      ok: false,
      issues: [
        {
          code: "systemd-unit-backup-unsafe",
          message: "Systemd service backup exposes gateway credentials.",
        },
      ],
    });

    const status = await gatherStatus({ probe: false });

    expect(auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({ command: null }),
    );
    expect(status.service.configAudit?.issues).toEqual([
      expect.objectContaining({ code: "systemd-unit-backup-unsafe" }),
    ]);
  });

  registerStatusTimeoutTests({
    gatherStatus,
    serviceIsLoaded,
    serviceReadRuntime,
    serviceReadCommand,
    auditGatewayServiceConfig,
    makeTempDir: () => tempDirs.make("status-native-timeout-"),
  });

  registerServiceInspectionStatusTests({
    serviceFixture,
    setCliConfig: (config) => {
      cliLoadedConfig = config;
    },
    isGatewayExternallySupervised,
    findSystemdGatewayInstallation,
    loadInstalledPluginIndexInstallRecords,
    serviceIsLoaded,
    serviceReadCommand,
    serviceReadRuntime,
    inspectGatewayRestart,
    gatherStatus,
    auditGatewayServiceConfig,
  });

  it("surfaces recent service restart handoffs only during deep status", async () => {
    readGatewayRestartHandoffSync.mockReturnValueOnce({
      kind: "gateway-supervisor-restart-handoff",
      version: 1,
      intentId: "intent-1",
      pid: 12_345,
      createdAt: 10_000,
      expiresAt: 70_000,
      reason: "plugin source changed",
      source: "plugin-change",
      restartKind: "full-process",
      supervisorMode: "launchd",
    });

    const status = await gatherStatus({ probe: false, deep: true });

    const handoffInput = callArg(readGatewayRestartHandoffSync) as NodeJS.ProcessEnv;
    expect(handoffInput.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-daemon");
    expect(handoffInput.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-daemon/openclaw.json");
    expect(status.service.restartHandoff?.reason).toBe("plugin source changed");
    expect(status.service.restartHandoff?.restartKind).toBe("full-process");
    expect(status.service.restartHandoff?.supervisorMode).toBe("launchd");
    const output = capturePrintedDaemonStatus(status, { json: false }).logs;
    expect(output).toContain("Recent restart handoff: full-process via launchd");
    expect(output).toContain("reason=plugin source changed");
  });

  it("prints the newer database refusal before loading deep status config", async () => {
    const stateDir = tempDirs.make("openclaw-status-newer-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
          CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT);
          INSERT INTO schema_meta VALUES ('primary', '2026.9.4');
        `);
    } finally {
      database.close();
    }
    const before = await fs.readFile(databasePath);
    const originalPreflight = await vi.importActual<
      typeof import("../../state/openclaw-database-preflight.js")
    >("../../state/openclaw-database-preflight.js");
    preflightOpenClawDatabaseSchemas.mockImplementation(
      originalPreflight.preflightOpenClawDatabaseSchemas,
    );
    serviceReadCommand.mockResolvedValueOnce(serviceCommand(env));
    const program = new Command().enablePositionalOptions().exitOverride();
    registerGatewayCli(program);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("status-exit");
    });
    try {
      await expect(
        program
          .parseAsync(["gateway", "status", "--deep", "--no-probe"], { from: "user" })
          .then(() => undefined),
      ).rejects.toThrow("status-exit");
      const output = error.mock.calls.flat().join("\n");
      expect(output).toContain("Gateway refused startup");
      expect(output).toContain(`schema ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      expect(output).toContain(`this build supports ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      expect(output).toContain("writer build 2026.9.4");
      expect(output).toContain(`Refused by OpenClaw ${VERSION}`);
      expect(output).toContain("pre-upgrade backup");
      expect(exit).toHaveBeenCalledWith(1);
      expect(createConfigIOCalls).not.toHaveBeenCalled();
      expect(readGatewayLastShutdown).not.toHaveBeenCalled();
      expect(await fs.readFile(databasePath)).toEqual(before);
    } finally {
      log.mockRestore();
      error.mockRestore();
      writeJson.mockRestore();
      exit.mockRestore();
    }
  });

  it("reports an unreadable state database instead of a config read failure", async () => {
    const stateDir = tempDirs.make("openclaw-status-unreadable-state-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database ".repeat(256));
    const before = await fs.readFile(databasePath);
    const originalPreflight = await vi.importActual<
      typeof import("../../state/openclaw-database-preflight.js")
    >("../../state/openclaw-database-preflight.js");
    preflightOpenClawDatabaseSchemas.mockImplementation(
      originalPreflight.preflightOpenClawDatabaseSchemas,
    );
    serviceReadCommand.mockResolvedValueOnce(serviceCommand(env));
    const program = new Command().enablePositionalOptions().exitOverride();
    registerGatewayCli(program);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("status-exit");
    });
    try {
      await expect(
        program
          .parseAsync(["gateway", "status", "--deep", "--no-probe", "--json"], { from: "user" })
          .then(() => undefined),
      ).rejects.toThrow("status-exit");
      const output = JSON.stringify(writeJson.mock.calls);
      expect(output).toContain(`shared state database is unreadable at ${databasePath}`);
      expect(output).toContain("restore this file from a verified backup");
      expect(output).not.toContain("CONFIG_READ_FAILED");
      expect(exit).toHaveBeenCalledWith(1);
      expect(createConfigIOCalls).not.toHaveBeenCalled();
      expect(await fs.readFile(databasePath)).toEqual(before);
    } finally {
      writeJson.mockRestore();
      exit.mockRestore();
    }
  });

  it("keeps readable shutdown history when a registered agent database has a newer schema", async () => {
    const stateDir = tempDirs.make("openclaw-status-readable-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const agentPath = path.join(stateDir, "agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`BEGIN; ${OPENCLAW_STATE_SCHEMA_SQL}
        PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        INSERT INTO gateway_boot_lifecycle VALUES
          ('prior-boot', 1, 1000, 2000, 'clean_stop', NULL, 'stop (SIGTERM)');
      `);
      database
        .prepare("INSERT INTO agent_databases VALUES ('optional', ?, ?, 1, NULL)")
        .run(agentPath, OPENCLAW_AGENT_SCHEMA_VERSION + 1);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const agent = new DatabaseSync(agentPath);
    try {
      agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    } finally {
      agent.close();
    }
    const originalPreflight = await vi.importActual<
      typeof import("../../state/openclaw-database-preflight.js")
    >("../../state/openclaw-database-preflight.js");
    preflightOpenClawDatabaseSchemas.mockImplementation(
      originalPreflight.preflightOpenClawDatabaseSchemas,
    );
    const originalLifecycle = await vi.importActual<
      typeof import("../../infra/gateway-boot-lifecycle.js")
    >("../../infra/gateway-boot-lifecycle.js");
    readGatewayLastShutdown.mockImplementation(originalLifecycle.readGatewayLastShutdown);
    serviceReadCommand.mockResolvedValueOnce(serviceCommand(env));

    const status = await gatherStatus({ deep: true, probe: false });

    expect(status.gateway?.lastShutdown).toEqual({
      reason: "stop (SIGTERM)",
      completedAtMs: 2000,
    });
    expect(capturePrintedDaemonStatus(status, { json: false }).logs).toContain(
      "Last shutdown: stop (SIGTERM) at 1970-01-01T00:00:02.000Z",
    );
  });

  it("reports dueling systemd diagnosis for its native target", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    findSystemdGatewayInstallation.mockResolvedValue({
      kind: "dueling",
      user: {
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/home/test/.config/systemd/user/openclaw-gateway.service",
      },
      system: {
        scope: "system",
        unitName: "openclaw-gateway.service",
        unitPath: "/etc/systemd/system/openclaw-gateway.service",
      },
    });
    try {
      const status = await gatherStatus({ probe: false, deep: true });
      const printed = capturePrintedDaemonStatus(status, { json: false, deep: true });
      const output = `${printed.logs}\n${printed.errors}`;
      expect(output.match(/they will SIGTERM each other/g)).toHaveLength(1);
      expect(output).toContain(status.gateway?.duelingScopesWarning);
      expect(output).toContain("Run `openclaw doctor` interactively");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.runIf(process.platform === "darwin")(
    "surfaces stale updater launchd jobs only during deep status",
    async () => {
      serviceReadCommand.mockResolvedValueOnce({
        programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
        environment: {
          ...daemonEnvironment,
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
        },
      });
      findStaleOpenClawUpdateLaunchdJobs.mockResolvedValueOnce([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
        },
        {
          label: "ai.openclaw.manual-update.1717168800",
          lastExitStatus: 0,
        },
      ]);

      const status = await gatherStatus({ probe: false, deep: true });

      const staleScanEnv = findStaleOpenClawUpdateLaunchdJobs.mock.calls[0]?.[0];
      expect(staleScanEnv?.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-daemon");
      expect(staleScanEnv?.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-daemon/openclaw.json");
      expect(staleScanEnv?.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.manual-update.gateway");
      expect(status.service.staleUpdateLaunchdJobs).toEqual([
        {
          label: "ai.openclaw.update.2026.5.12",
          lastExitStatus: 127,
        },
        {
          label: "ai.openclaw.manual-update.1717168800",
          lastExitStatus: 0,
        },
      ]);
    },
  );

  it("surfaces foreign launchd jobs and restart correlation without --deep", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const job: ForeignLaunchdJob = {
        label: "ai.openclaw.test.w15.restart",
        program: "/tmp/openclaw-test/restart.sh",
        keepAlive: true,
        gatewayActions: ["restart"],
        safeToRemove: true,
      };
      findForeignLaunchdJobs.mockResolvedValue([job]);

      const status = await gatherStatus({ probe: false });

      const output = capturePrintedDaemonStatus(status, { json: false }).errors;
      expect(output).toContain("Foreign launchd jobs detected");
      expect(output).toContain(job.label);
      expect(output).toContain(job.program);
      expect(output).toContain("keepalive=true");
      expect(output).toContain("Gateway lifecycle=restart");
      expect(output).toContain("3 external forced Gateway restart(s)");
      expect(output).toContain("openclaw doctor --fix");
      expect(status.service.foreignLaunchdJobs).toEqual([job]);
      expect(status.service.forcedRestartSummary).toEqual({ count: 3, windowMs: 600_000 });
      expect(findForeignLaunchdJobs.mock.calls[0]?.[0]?.OPENCLAW_STATE_DIR).toBe(
        "/tmp/openclaw-daemon",
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("surfaces established gateway connections during deep status", async () => {
    inspectPortConnections.mockResolvedValueOnce({
      port: 19001,
      connections: [
        {
          pid: 4242,
          ppid: 1,
          command: "node",
          commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
          address: "TCP 127.0.0.1:50123->127.0.0.1:19001 (ESTABLISHED)",
          direction: "client",
        },
      ],
    });

    const status = await gatherStatus({ probe: false, deep: true });

    expect(inspectPortConnections).toHaveBeenCalledWith(19001);
    expect(status.connections?.established).toEqual([
      {
        pid: 4242,
        ppid: 1,
        command: "node",
        commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
        address: "TCP 127.0.0.1:50123->127.0.0.1:19001 (ESTABLISHED)",
        direction: "client",
      },
    ]);
    const output = capturePrintedDaemonStatus(status, { json: false }).logs;
    expect(output).toContain("Established clients: 1");
    expect(output).toContain("pid=4242");
    expect(output).toContain("newer-openclaw");
    expect(output).toContain("client");
    expect(output).toContain("protocol mismatch after rollback");
  });

  it("skips local inspections for an explicit remote target", async () => {
    preflightOpenClawDatabaseSchemas.mockRejectedValue(new Error("local state is unavailable"));
    daemonLoadedConfig = {
      gateway: {
        mode: "remote",
        bind: "lan",
        remote: { url: "wss://gateway.example" },
      },
    };

    const status = await gatherStatus({
      probe: false,
      deep: true,
      rpc: { url: "wss://gateway.example" },
    });

    expect(inspectPortConnections).not.toHaveBeenCalled();
    expect(inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(findSystemdGatewayInstallation).not.toHaveBeenCalled();
    expect(status.connections).toBeUndefined();
    expect(status.pluginVersionDrift).toBeUndefined();
    expect(preflightOpenClawDatabaseSchemas).not.toHaveBeenCalled();
    expect(readGatewayLastShutdown).not.toHaveBeenCalled();
  });

  registerStatusConfigReadTests({
    gatherStatus,
    withStatusConfig,
    createConfigIOCalls,
    readConfigFileSnapshotCalls,
    loadConfigCalls,
    probeInput,
    setInvalidConfig: (config) => {
      cliLoadedConfig = config;
      configIssues = [{ path: "agents.defaults", message: 'Unrecognized key: "retiredSetting"' }];
    },
  });

  it("uses full plugin-aware config validation for deep status", async () => {
    await withStatusConfig(
      JSON.stringify({
        gateway: {
          bind: "loopback",
        },
      }),
      async (configPath) => {
        cliLoadedConfig = {
          gateway: {
            bind: "loopback",
          },
        };
        cliConfigWarnings = [
          {
            path: "plugins.entries.test-bad-plugin",
            message:
              "plugin test-bad-plugin: channel plugin manifest declares test-bad-plugin without channelConfigs metadata",
          },
        ];

        const status = await gatherStatus({ probe: false, deep: true });

        expect(createConfigIOCalls).toHaveBeenCalledWith(configPath, "full", false);
        expect(readConfigFileSnapshotCalls).toHaveBeenCalledWith(configPath);
        expect(status.config?.cli.warnings).toEqual(cliConfigWarnings);
        const output = capturePrintedDaemonStatus(status, { json: false }).errors;
        expect(output).toContain("Config warnings:");
        expect(output).toContain("without channelConfigs metadata");
        expect(status.config?.daemon).toBe(status.config?.cli);
      },
    );
  });

  it("keeps the redacted optional proxy password warning after a successful probe", async () => {
    daemonLoadedConfig = { gateway: { auth: { mode: "trusted-proxy" } } };
    setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", REDACTED_SENTINEL);

    const status = await gatherStatus({ deep: true });

    expect(status.rpc?.ok).toBe(true);
    expect(status.rpc?.authWarning).toContain("local password fallback");
    expect(probeInput().password).toBeUndefined();
    expect(capturePrintedDaemonStatus(status, { json: false, deep: true }).errors).toContain(
      "redaction sentinel",
    );
  });

  it("skips exec SecretRef probe auth when exec refs are disabled", async () => {
    daemonLoadedConfig = {
      gateway: {
        bind: "lan",
        tls: { enabled: true },
        auth: {
          mode: "token",
          token: {
            source: "exec",
            provider: "vault",
            id: "gateway/credential",
          },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };

    const status = await gatherStatus({ allowExecSecretRefs: false });

    expect(resolveGatewayProbeAuthSafeWithSecretInputsCalls).not.toHaveBeenCalled();
    const input = probeInput();
    expect(input.token).toBeUndefined();
    expect(input.password).toBeUndefined();
    expect(input.allowRpcConfigCredentials).toBe(false);
    expect(status.rpc?.authWarning).toContain(
      "gateway credentials use an exec SecretRef and exec SecretRefs are disabled",
    );
  });

  it("keeps service password auth independent of unused remote exec SecretRefs", async () => {
    daemonLoadedConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          password: { source: "exec", provider: "vault", id: "gateway/remote-password" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    };
    setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", "ambient-password"); // pragma: allowlist secret

    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
      allowExecSecretRefs: false,
    });

    expect(resolveGatewayProbeAuthSafeWithSecretInputsCalls).toHaveBeenCalledTimes(1);
    const input = probeInput();
    expect(input.token).toBeUndefined();
    expect(input.password).toBe("ambient-password");
    expect(input.allowRpcConfigCredentials).toBe(true);
    expect(status.rpc?.authWarning).toBeUndefined();
  });

  it.each([
    { ok: true, redacted: false },
    { ok: false, redacted: false },
    { ok: true, redacted: true },
  ])(
    "reports unavailable probe auth with redacted=$redacted and ok=$ok",
    async ({ ok, redacted }) => {
      const id = redacted ? "DAEMON_GATEWAY_TOKEN" : "MISSING_DAEMON_GATEWAY_TOKEN";
      daemonLoadedConfig = {
        gateway: {
          bind: "lan",
          tls: { enabled: true },
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id },
          },
        },
        secrets: { providers: { default: { source: "env" } } },
      };
      if (redacted) {
        setTestEnvValue("DAEMON_GATEWAY_TOKEN", REDACTED_SENTINEL);
      }
      callGatewayStatusProbe.mockResolvedValueOnce({
        ok,
        url: "wss://127.0.0.1:19001",
        ...(ok ? {} : { error: "gateway closed" }),
      });
      const status = await gatherStatus({ deep: redacted });
      const input = probeInput();
      expect(input.token).toBeUndefined();
      expect(input.password).toBeUndefined();
      expect(status.rpc?.ok).toBe(ok);
      if (!redacted) {
        if (ok) {
          expect(status.rpc?.authWarning).toBeUndefined();
        } else {
          expect(status.rpc?.authWarning).toContain(
            "gateway.auth.token SecretRef is unresolved in this command path",
          );
          expect(status.rpc?.authWarning).toContain("checking without configured auth credentials");
        }
        return;
      }
      expect(status.rpc?.authWarning).toContain("env:default:DAEMON_GATEWAY_TOKEN");
      expect(status.rpc?.authWarning).toContain("redaction placeholder");
      expect(status.rpc?.authWarning).toContain("openclaw doctor --fix");
      expect(capturePrintedDaemonStatus(status, { json: false, deep: true }).errors).toContain(
        "redaction placeholder",
      );
    },
  );

  it("surfaces stale gateway listener pids from restart health inspection when probe fails", async () => {
    serviceReadRuntime.mockResolvedValueOnce({ status: "running", pid: 8000 });
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:19001",
      error: "timeout",
    });
    inspectGatewayRestart.mockResolvedValueOnce({
      runtime: { status: "running", pid: 8000 },
      portUsage: {
        port: 19001,
        status: "busy",
        listeners: [{ pid: 9000, ppid: 8999, commandLine: "openclaw-gateway" }],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [9000],
    });

    const status = await gatherStatus();

    expect((callArg(inspectGatewayRestart) as { port?: number }).port).toBe(19001);
    expect(status.health).toEqual({
      healthy: false,
      staleGatewayPids: [9000],
    });
    const output = capturePrintedDaemonStatus(status, { json: false });
    expect(output.errors).toContain("Gateway runtime PID does not own the listening port");
    expect(output.errors).toContain("openclaw gateway restart");
    expect(output.logs).toContain("Warm-up: launch agents can take a few seconds");
    expect(output.logs).not.toContain("Gateway process is running and owns the gateway port");
  });

  it("includes the last gateway error when the service is listening but the RPC probe fails", async () => {
    inspectPortUsages.mockResolvedValueOnce(
      new Map([
        [
          19001,
          {
            port: 19001,
            status: "busy",
            listeners: [{ pid: 8000, ppid: 1, commandLine: "openclaw gateway" }],
            hints: [],
          },
        ],
      ]),
    );
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: false,
      url: "wss://127.0.0.1:19001",
      error: "gateway closed (1000): ",
    });
    readLastGatewayErrorLine.mockResolvedValueOnce(
      "parse/handle error: Error: ENOSPC: no space left on device, write",
    );

    const status = await gatherStatus();

    expect(readLastGatewayErrorLine).toHaveBeenCalledWith(
      expect.objectContaining({
        ...daemonEnvironment,
      }),
      { requirePatternMatch: true },
    );
    expect(status.port?.status).toBe("busy");
    expect(status.rpc?.ok).toBe(false);
    expect(status.lastError).toBe(
      "parse/handle error: Error: ENOSPC: no space left on device, write",
    );
    const output = capturePrintedDaemonStatus(status, { json: false }).errors;
    expect(output).toContain("Connectivity check: failed");
    expect(output).toContain("gateway closed (1000):");
    expect(output).toContain(
      "Last gateway error: parse/handle error: Error: ENOSPC: no space left on device, write",
    );
  });

  it("compares plugin drift against the running gateway version from the probe, not the CLI VERSION", async () => {
    // Gateway is still running an older version than the invoking CLI.
    // An npm plugin pinned to the running gateway version must NOT be
    // reported as drifted just because the CLI package is newer.
    callGatewayStatusProbe.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:19001",
      error: null,
      server: { version: "2026.5.4", connId: "c1" },
    } as never);
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      brave: {
        source: "npm",
        spec: "@openclaw/brave-plugin@2026.5.3",
        resolvedName: "@openclaw/brave-plugin",
        resolvedVersion: "2026.5.3",
      },
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.4",
      },
    } as never);

    const status = await gatherStatus();

    expect(status.pluginVersionDrift?.gatewayVersion).toBe("2026.5.4");
    expect(status.pluginVersionDrift?.drifts.map((drift) => drift.pluginId)).toEqual(["brave"]);
    expect(status.pluginVersionDrift?.drifts[0]?.targetResolution).toBeUndefined();
    const output = capturePrintedDaemonStatus(status, { json: false }).logs;
    expect(output).toContain("Plugin version drift: 1 active official plugin");
    expect(output).toContain("openclaw gateway status --deep");
    expect(output).not.toContain("brave:");
    expect(fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
    expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon" }),
      }),
    );
  });

  it.each([
    { name: "running an older version", runtime: "running", probeVersion: "2026.5.4" },
    { name: "stopped", runtime: "stopped", probeVersion: undefined },
  ])(
    "compares Doctor plugin readiness with the installed service when the Gateway is $name",
    async ({ runtime, probeVersion }) => {
      const packageRoot = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-readiness-")),
      );
      try {
        await fs.mkdir(path.join(packageRoot, "dist"));
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.6.1" }),
        );
        const entrypoint = path.join(packageRoot, "dist", "index.js");
        await fs.writeFile(entrypoint, "gateway");
        serviceReadCommand.mockResolvedValueOnce({
          programArguments: [process.execPath, entrypoint, "gateway", "run"],
          environment: {
            OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
            OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
          },
        });
        serviceReadRuntime.mockResolvedValueOnce({ status: runtime });
        callGatewayStatusProbe.mockResolvedValueOnce(
          probeVersion
            ? {
                ok: true,
                server: { version: probeVersion, connId: "c1" },
              }
            : { ok: false, error: "connect failed" },
        );
        loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
          whatsapp: {
            source: "npm",
            resolvedName: "@openclaw/whatsapp",
            resolvedVersion: "2026.5.4",
          },
        } as never);

        const status = await gatherStatus({ pluginVersionTarget: "restart" });

        expect(status.pluginVersionDrift).toBeUndefined();
        expect(status.pluginVersionRestartReadiness).toEqual({
          status: "resolved",
          report: {
            gatewayVersion: "2026.6.1",
            drifts: [expect.objectContaining({ pluginId: "whatsapp" })],
          },
          ...(probeVersion ? { runningGatewayVersion: probeVersion } : {}),
        });
      } finally {
        await fs.rm(packageRoot, { recursive: true, force: true });
      }
    },
  );

  it("reports unresolved restart readiness when the service package cannot be identified", async () => {
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.4",
      },
    } as never);
    const status = await gatherStatus({ pluginVersionTarget: "restart" });

    expect(status.pluginVersionRestartReadiness).toEqual({
      status: "unresolved",
      reason: expect.stringContaining("package version is unavailable"),
      runningGatewayVersion: "2026.5.6",
    });
  });

  it("omits restart readiness when no managed service target exists", async () => {
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceReadCommand.mockResolvedValueOnce(null);

    const status = await gatherStatus({
      pluginVersionTarget: "restart",
      requireRpc: true,
      deep: true,
    });

    expect(status.pluginVersionRestartReadiness).toBeUndefined();
    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(status.gateway?.probeUrl).toBe("ws://127.0.0.1:18789");
    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(status.service.targetRole).toBe("target");
  });

  it("reports unresolved restart readiness when a loaded service has no command", async () => {
    serviceReadCommand.mockResolvedValueOnce(null);
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.4",
      },
    } as never);

    const status = await gatherStatus({ pluginVersionTarget: "restart" });

    expect(status.pluginVersionRestartReadiness).toEqual({
      status: "unresolved",
      reason: expect.stringContaining("service command is unavailable"),
      runningGatewayVersion: "2026.5.6",
    });
  });

  it("omits restart readiness when no active official plugins need a version check", async () => {
    const status = await gatherStatus({ pluginVersionTarget: "restart" });

    expect(status.pluginVersionRestartReadiness).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
