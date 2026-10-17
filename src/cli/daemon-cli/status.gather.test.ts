import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import { Command } from "commander";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { REDACTED_SENTINEL } from "../../config/redact-sentinel.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { SecretRef } from "../../config/types.secrets.js";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import type { ForeignLaunchdJob } from "../../daemon/launchd-foreign-jobs.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
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
import * as gatewayBootLifecycle from "../../infra/gateway-boot-lifecycle.js";
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
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
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
  type PortUsageTestSummary,
} from "./status.gather.probes.test-support.js";
import {
  registerServiceInspectionStatusTests,
  statusCommand,
} from "./status.gather.service-inspection.test-support.js";
import { registerStatusTimeoutTests } from "./status.gather.timeout.test-support.js";

const readFile = fs.readFile.bind(fs);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let readFileSpy: ReturnType<typeof vi.spyOn>;
const serviceFixture = vi.hoisted(() => ({ label: "LaunchAgent", useSystemdCommand: false }));
const preflightSchemas = vi.fn<
  typeof import("../../state/openclaw-database-preflight.js").preflightOpenClawDatabaseSchemas
>(async () => ({ incompatible: [], indeterminate: [] }));
const isDefaultInstallIdentity = vi.fn((_env?: NodeJS.ProcessEnv) => true);
const isGatewayExternallySupervised = vi.fn((_env?: NodeJS.ProcessEnv) => false);
const probeAuthCalls = vi.fn<(opts?: unknown) => void>();
const installedPlugins = vi.fn<
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
const restartHandoff = vi.fn<(_env?: NodeJS.ProcessEnv) => GatewayRestartHandoff | null>(
  () => null,
);
const originalReadGatewayLastShutdown = gatewayBootLifecycle.readGatewayLastShutdownAsync;
const readGatewayLastShutdownAsync = vi.spyOn(gatewayBootLifecycle, "readGatewayLastShutdownAsync");
const findSystemdGatewayInstallation = vi.fn<
  typeof import("../../daemon/systemd-scope.js").findSystemdGatewayInstallation
>(async () => ({ kind: "none" }));
const inspectWindowsGatewayFirewall = vi.fn<(opts?: unknown) => Promise<unknown>>(async () => ({
  applies: false,
}));
const auditGatewayServiceConfig = vi.fn<(_opts?: unknown) => Promise<ServiceConfigAudit>>(
  async () => ({ ok: true, issues: [] }),
);
const serviceIsLoaded = vi.fn<
  (opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<boolean>
>(async () => true);
const serviceReadRuntime = vi.fn<
  (_env?: NodeJS.ProcessEnv, _opts?: { timeoutMs?: number }) => Promise<GatewayServiceRuntime>
>(async () => ({ status: "running" }));
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
  return { programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"], environment };
}
function portUsage(
  port: number,
  listeners: PortUsageTestSummary["listeners"] = [],
): PortUsageTestSummary {
  return { port, status: listeners.length ? "busy" : "free", listeners, hints: [] };
}
function npmPlugin(id: string, version: string) {
  return { source: "npm", resolvedName: `@openclaw/${id}`, resolvedVersion: version };
}
const whatsappPlugins = { whatsapp: npmPlugin("whatsapp", "2026.5.4") };
function execRef(id: string): SecretRef {
  return { source: "exec", provider: "vault", id };
}
function failedProbe(error: string, url = "ws://127.0.0.1:19001") {
  return { ok: false, url, error };
}
function systemdService(scope: "user" | "system", label = "openclaw.service"): ExtraGatewayService {
  const root = scope === "user" ? "/home/test/.config/systemd/user" : "/etc/systemd/system";
  return { platform: "linux", label, scope, detail: `unit: ${root}/${label}` };
}

type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
const edgeAuthValue = "synthetic-status-edge-auth";
const edgeAuth = { "X-Test-Edge-Auth": edgeAuthValue };
const execSecrets = { providers: { vault: { source: "exec", command: "/bin/false" } } };
function remoteGateway(
  url: string,
  auth: GatewayConfig["auth"],
  remote: Partial<GatewayConfig["remote"]> = {},
) {
  return {
    mode: "remote",
    tls: { enabled: true },
    auth,
    remote: {
      url,
      edgeAuth,
      token: "remote-token",
      password: "remote-password",
      tlsFingerprint: "sha256:99:88:77:66",
      ...remote,
    },
  };
}
function expectProbeGateway(
  gateway: GatewayConfig | undefined,
  url: string,
  auth?: GatewayConfig["auth"],
) {
  expect(gateway?.mode).toBe("local");
  expect(gateway?.remote).toEqual({ url, edgeAuth, tlsFingerprint: "sha256:99:88:77:66" });
  expect(gateway?.auth).toEqual(auth);
  expect(gateway?.tls).toBeUndefined();
}
async function useDatabasePreflight(env: Record<string, string>) {
  const actual = await vi.importActual<typeof import("../../state/openclaw-database-preflight.js")>(
    "../../state/openclaw-database-preflight.js",
  );
  preflightSchemas.mockImplementation(actual.preflightOpenClawDatabaseSchemas);
  serviceReadCommand.mockResolvedValueOnce(serviceCommand(env));
}
function writeDatabase(
  databasePath: string,
  write: (database: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>) => void,
) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    write(database);
  } finally {
    database.close();
  }
}
const serviceReadCommand = vi.fn<
  (env?: NodeJS.ProcessEnv) => Promise<GatewayServiceCommandConfig | null>
>(async () => serviceCommand());
const resolveGatewayBindHost = vi.fn(async (bindMode?: string, _customBindHost?: string) =>
  bindMode === "loopback" ? "127.0.0.1" : "0.0.0.0",
);
const advertisedLinks = vi.fn(async (_opts?: unknown) => ({
  httpUrl: "https://10.211.55.3:19001/",
  wsUrl: "wss://10.211.55.3:19001",
}));
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.9");
const resolveGatewayPort = vi.fn((_cfg?: unknown, _env?: unknown) => 18789);
const resolveStateDir = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-cli",
);
const resolveConfigPath = vi.fn(
  (env: NodeJS.ProcessEnv, stateDir: string) =>
    env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
);
const createConfigIOCalls =
  vi.fn<(configPath: string, pluginValidation?: "full" | "skip", observe?: boolean) => void>();
const readConfigFileSnapshotCalls = vi.fn((configPath: string) => configPath);
const loadConfigCalls = vi.fn((configPath: string) => configPath);
let cliConfigWarnings: Array<{ path: string; message: string }> = [];
let configIssues: Array<{ path: string; message: string }> = [];
let daemonLoadedConfig: Record<string, unknown>;
let cliLoadedConfig: Record<string, unknown>;

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
  isDefaultInstallIdentity: deferredMock(() => isDefaultInstallIdentity),
  resolveConfigPath: deferredMock(() => resolveConfigPath),
  resolveGatewayPort: deferredMock(() => resolveGatewayPort),
  resolveStateDir: deferredMock(() => resolveStateDir),
}));

// mock-isolation: Keep config reads on per-test fixtures, outside the operator's state.
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
    const warnings = isDaemon ? [] : cliConfigWarnings;
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

// mock-isolation: Status collection must not read the operator service logs.
vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: deferredMock(() => readLastGatewayErrorLine),
}));
vi.mock("../../daemon/inspect.js", () => ({
  findExtraGatewayServices: deferredMock(() => findExtraGatewayServices),
}));
vi.mock("../../state/openclaw-database-preflight.js", () => ({
  OpenClawDatabaseSchemaPreflightError,
  preflightOpenClawDatabaseSchemas: deferredMock(() => preflightSchemas),
}));
vi.mock("../../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-scope.js")>()),
  findSystemdGatewayInstallation: deferredMock(() => findSystemdGatewayInstallation),
}));
vi.mock("../../daemon/launchd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd.js")>()),
  findStaleOpenClawUpdateLaunchdJobs: deferredMock(() => findStaleOpenClawUpdateLaunchdJobs),
}));
vi.mock("../../daemon/launchd-foreign-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-foreign-jobs.js")>()),
  findForeignLaunchdJobs: deferredMock(() => findForeignLaunchdJobs),
}));
vi.mock("../../daemon/restart-storm.js", () => ({
  readGatewayForcedRestartSummary: () => ({ count: 3, windowMs: 600_000 }),
}));
vi.mock("../../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: deferredMock(() => auditGatewayServiceConfig),
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
  resolveGatewayBindHost: deferredMock(() => resolveGatewayBindHost),
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(bindHost) && bindHost !== "0.0.0.0" && bindHost !== "127.0.0.1"
      ? [bindHost, "127.0.0.1"]
      : [bindHost],
}));
vi.mock("../../gateway/control-ui-links.js", () => ({
  resolveAdvertisedControlUiLinks: deferredMock(() => advertisedLinks),
}));
vi.mock("../../gateway/probe-auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGatewayProbeAuthSafeWithSecretInputs: async (opts: unknown) => {
      probeAuthCalls(opts);
      return await (
        actual.resolveGatewayProbeAuthSafeWithSecretInputs as (opts: unknown) => Promise<unknown>
      )(opts);
    },
  };
});
vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortConnections: deferredMock(() => inspectPortConnections),
  inspectPortUsage: deferredMock(() => inspectPortUsage),
  inspectPortUsages: deferredMock(() => inspectPortUsages),
}));
vi.mock("../../infra/ports-format.js", () => ({
  formatPortDiagnostics: deferredMock(() => formatPortDiagnostics),
}));
vi.mock("../../infra/restart-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-handoff.js")>()),
  readGatewayRestartHandoffSync: deferredMock(() => restartHandoff),
}));
vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  isGatewayExternallySupervised: deferredMock(() => isGatewayExternallySupervised),
}));
vi.mock("../../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: deferredMock(() => pickPrimaryTailnetIPv4),
}));
vi.mock("../../infra/tls/gateway.js", () => ({
  inspectGatewayTlsCertificate: deferredMock(() => inspectGatewayTlsCertificate),
}));
vi.mock("../../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: deferredMock(() => inspectWindowsGatewayFirewall),
}));
vi.mock("../../infra/update-check-package-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check-package-target.js")>()),
  fetchNpmPackageTargetStatus: deferredMock(() => fetchNpmPackageTargetStatus),
}));
vi.mock("./probe.js", () => ({
  probeGatewayStatus: (opts: GatewayStatusProbeOptions) => callGatewayStatusProbe(opts),
}));
vi.mock("../../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords: deferredMock(() => installedPlugins),
}));
vi.mock("./restart-health.js", () => ({
  inspectGatewayRestart: deferredMock(() => inspectGatewayRestart),
}));

// Vitest hoists factories; resolve the per-test mock only when the owner calls it.
function deferredMock<Args extends unknown[], Result>(get: () => (...args: Args) => Result) {
  return (...args: Args) => get()(...args);
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
      ? { environment: { OPENCLAW_STATE_DIR: tmp, OPENCLAW_CONFIG_PATH: configPath } }
      : {}),
  });
  return await run(configPath);
}
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(() => {
  vi.resetAllMocks();
  serviceFixture.useSystemdCommand = false;
  serviceFixture.label = "LaunchAgent";
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
  formatPortDiagnostics.mockReturnValue(["port diagnostics"]);
  readGatewayLastShutdownAsync.mockResolvedValue(undefined);
  cliConfigWarnings = [];
  configIssues = [];
  daemonLoadedConfig = {
    gateway: { bind: "lan", tls: { enabled: true }, auth: { token: "daemon-token" } },
  };
  cliLoadedConfig = { gateway: { bind: "loopback" } };
});

afterEach(() => {
  readFileSpy.mockRestore();
  envSnapshot.restore();
});

it("excludes only the observed systemd unit and scope", async () => {
  serviceFixture.label = "systemd";
  const userService = systemdService("user");
  const systemService = systemdService("system");
  const otherService = systemdService("system", "openclaw-rescue.service");
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
  await withMockedPlatform("linux", async () => {
    const status = await gatherStatus({ probe: false, deep: true });
    expect(status.extraServices).toEqual([userService, otherService]);
    expect(status.service.label).toBe("systemd system");
  });
});

it.each([
  ["service-none", "wss://remote.example:19443", true],
  ["service-token", "wss://127.0.0.1:19001/other", false],
  ["explicit-none", "wss://explicit.example:19445", false],
  ["explicit-password", "wss://explicit.example:19445", true],
] as const)(
  "isolates %s credentials with remote=%s and requireRpc=%s",
  async (mode, remoteUrl, requireRpc) => {
    const explicit = mode.startsWith("explicit");
    const noAuth = mode === "service-none";
    const password = mode === "explicit-password" ? "explicit-password" : undefined;
    const auth: GatewayConfig["auth"] = noAuth
      ? { mode: "none" }
      : {
          mode: "token",
          token: explicit ? execRef("gateway/token") : "service-config-token",
          ...(explicit ? {} : { password: "local-password" }),
        };
    daemonLoadedConfig = {
      gateway: {
        ...remoteGateway(
          remoteUrl,
          auth,
          explicit ? {} : { token: execRef("gateway/remote-token") },
        ),
        ...(explicit ? {} : { bind: "loopback" }),
      },
      secrets: execSecrets,
    };
    const originalConfig = structuredClone(daemonLoadedConfig);
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "ambient-token");
    if (!explicit) {
      serviceReadCommand.mockResolvedValueOnce(
        serviceCommand({ ...daemonEnvironment, OPENCLAW_GATEWAY_TOKEN: "service-env-token" }),
      );
      setTestEnvValue("OPENCLAW_GATEWAY_URL", "wss://ambient.example:19444");
    }
    const status = await gatherStatus({
      rpc: explicit ? { url: remoteUrl, ...(password ? { password } : {}) } : {},
      requireRpc,
      allowExecSecretRefs: false,
    });
    const input = probeInput();
    expect(input).toMatchObject({
      url: explicit ? remoteUrl : "wss://127.0.0.1:19001",
      requireRpc,
    });
    expect({ token: input.token, password: input.password }).toEqual({
      token: explicit || noAuth ? undefined : "service-config-token",
      password: explicit ? password : noAuth ? undefined : "local-password",
    });
    expect(input.urlOverride).toBe(explicit ? remoteUrl : undefined);
    expect(input.tlsFingerprint).toBe(explicit ? undefined : "sha256:11:22:33:44");
    assert(input.config);
    expect(gatewayEdgeAuthValueForTarget({ config: input.config, targetUrl: input.url })).toEqual(
      remoteUrl === input.url ? edgeAuth : undefined,
    );
    expectProbeGateway(
      input.config.gateway,
      remoteUrl,
      explicit ? undefined : { mode: noAuth ? "none" : "token" },
    );
    if (explicit) {
      expect(status.rpc?.authWarning).toBeUndefined();
      expect(inspectGatewayTlsCertificate).not.toHaveBeenCalled();
      expect(probeAuthCalls).not.toHaveBeenCalled();
    } else {
      expect(status.rpc?.url).toBe(input.url);
    }
    expect(daemonLoadedConfig).toEqual(originalConfig);
  },
);

it.each([true, false])(
  "enforces saved TLS pin match=%s before explicit status traffic",
  async (pinMatches) => {
    const actualProbe = await vi.importActual<typeof import("./probe.js")>("./probe.js");
    const originalProbe = callGatewayStatusProbe.getMockImplementation();
    assert(originalProbe);
    const server = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
    const sockets = new Set<Socket>();
    const closedSockets: Promise<void>[] = [];
    const edgeAuthHeaders: unknown[] = [];
    const connectTokens: Array<string | undefined> = [];
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
          gateway: remoteGateway(
            url,
            { mode: "token", token: "unrelated-service-token" },
            { tlsFingerprint: savedPin },
          ),
        }),
        async () => {
          const status = await gatherStatus({
            rpc: { url, token: explicitToken, json: true, timeout: "2000" },
            requireRpc: false,
          });
          await Promise.all(closedSockets);
          const input = probeInput();
          expect(input.tlsFingerprint).toBeUndefined();
          expect(input.config?.gateway?.remote).toEqual({
            url,
            edgeAuth,
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
  },
);

it("targets the status command port instead of its parent gateway port", async () => {
  const argv = ["gateway", "--port", "19003", "status", "--port", "19002"];
  const program = new Command().enablePositionalOptions().exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerGatewayCli(program);
  registerDaemonCli(program);
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  try {
    await program.parseAsync([...argv, "--json"], { from: "user" });
    expect(probeInput()).toMatchObject({
      url: "ws://127.0.0.1:19002",
      localPortOverride: 19002,
      configPath: "/tmp/openclaw-cli/openclaw.json",
    });
    expect(probeInput().config).toEqual({
      gateway: {
        bind: "loopback",
        mode: "local",
        remote: undefined,
        auth: undefined,
        tls: undefined,
      },
    });
    expect(writeJson.mock.calls[0]?.[0]).toMatchObject({
      gateway: { port: 19002, portSource: "cli", probeUrl: "ws://127.0.0.1:19002" },
      rpc: { url: "ws://127.0.0.1:19002" },
      service: { targetRole: "diagnostic-only" },
    });
  } finally {
    writeJson.mockRestore();
  }
});

it("keeps an explicit local port in remote config when probing", async () => {
  cliLoadedConfig = {
    gateway: {
      mode: "remote",
      bind: "tailnet",
      tls: { enabled: true },
      auth: { token: "local-token" },
      remote: { url: "wss://gateway.example", token: "remote-token" },
    },
  };
  const status = await gatherStatus({ rpc: { localPortOverride: 19002 }, deep: true });
  expect(status.gateway).toMatchObject({
    port: 19002,
    portSource: "cli",
    probeUrl: "wss://127.0.0.1:19002",
  });
  expect(inspectPortConnections).toHaveBeenCalledWith(19002);
  expect(status.service.targetRole).toBe("diagnostic-only");
  expect(findSystemdGatewayInstallation).not.toHaveBeenCalled();
  expect(inspectGatewayRestart).not.toHaveBeenCalled();
  expect(probeInput()).toMatchObject({
    url: "wss://127.0.0.1:19002",
    token: "local-token",
    tlsFingerprint: "sha256:11:22:33:44",
  });
});

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

it("includes Windows firewall diagnostics during deep LAN gateway status", async () => {
  inspectWindowsGatewayFirewall.mockResolvedValueOnce({
    applies: true,
    severity: "warning",
    code: "windows_firewall_local_rules_ignored",
    message: "Windows Firewall may ignore local Gateway allow rules for this network profile.",
    details: ["Windows reports LocalFirewallRules as N/A (GPO-store only)."],
  });
  const status = await gatherStatus({ probe: false, deep: true });
  expect(inspectWindowsGatewayFirewall.mock.calls[0]?.[0]).toMatchObject({
    bind: "lan",
    mode: "quick",
    port: 19001,
  });
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
  expect(status).toMatchObject({ gateway: { version: "2026.5.7" }, rpc: { version: "2026.5.7" } });
  expect(status.rpc?.server).toBeUndefined();
  const output = capturePrintedDaemonStatus(status, { json: false });
  expect(output.logs).toContain("Gateway version: 2026.5.7");
  expect(output.errors).toContain(`this OpenClaw command is version ${VERSION}`);
});

it("uses raw explicit URLs for probes but redacts them from status diagnostics", async () => {
  const rawUrl =
    "wss://user:password@override.example:18790/ws?token=secret&key=api-key&X-Amz-Signature=signed";
  callGatewayStatusProbe.mockResolvedValueOnce(
    failedProbe("connect ECONNREFUSED override.example:18790", rawUrl),
  );
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
  expect(diagnosticUrls).not.toMatch(/user|password|secret|api-key|signed/);
  expect(installedPlugins).not.toHaveBeenCalled();
  expect(status.pluginVersionDrift).toBeUndefined();
  expect(status.service.targetRole).toBe("diagnostic-only");
  expect(inspectGatewayRestart).not.toHaveBeenCalled();
});

it("uses the active external supervisor context instead of an unrelated native service", async () => {
  setTestEnvValue("OPENCLAW_GATEWAY_PORT", "18900");
  isGatewayExternallySupervised.mockReturnValue(true);
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
  callGatewayStatusProbe.mockResolvedValueOnce(
    failedProbe("connect ECONNREFUSED 127.0.0.1:18900", "ws://127.0.0.1:18900"),
  );
  installedPlugins.mockResolvedValueOnce(whatsappPlugins);
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
  const authInput = probeAuthCalls.mock.calls[0]?.[0] as {
    cfg?: unknown;
    env?: NodeJS.ProcessEnv;
  };
  expect(authInput.cfg).toBe(cliLoadedConfig);
  expect(authInput.env?.OPENCLAW_GATEWAY_PORT).toBe("18900");
  expect(status.service.targetRole).toBe("diagnostic-only");
  expect(status.pluginVersionRestartReadiness).toBeUndefined();
  expect(inspectGatewayRestart).not.toHaveBeenCalled();
});

it("uses fallback network details when interface discovery throws during status inspection", async () => {
  daemonLoadedConfig = {
    gateway: { bind: "tailnet", tls: { enabled: true }, auth: { token: "daemon-token" } },
  };
  resolveGatewayBindHost.mockImplementationOnce(async () => {
    throw new Error("uv_interface_addresses failed");
  });
  pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
    throw new Error("uv_interface_addresses failed");
  });
  const status = await gatherStatus();
  expect(status.gateway).toMatchObject({
    bindMode: "tailnet",
    bindHost: "127.0.0.1",
    probeUrl: "wss://127.0.0.1:19001",
  });
  expect(status.gateway?.probeNote).toContain("interface discovery failed");
  expect(status.gateway?.probeNote).toContain("tailnet addresses");
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
  findSystemdGatewayInstallation,
  loadInstalledPluginIndexInstallRecords: installedPlugins,
  serviceIsLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  inspectGatewayRestart,
  gatherStatus,
});

it("surfaces recent service restart handoffs only during deep status", async () => {
  restartHandoff.mockReturnValueOnce({
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
  expect(restartHandoff.mock.calls[0]?.[0]).toMatchObject(daemonEnvironment);
  expect(status.service.restartHandoff).toMatchObject({
    reason: "plugin source changed",
    restartKind: "full-process",
    supervisorMode: "launchd",
  });
  const output = capturePrintedDaemonStatus(status, { json: false }).logs;
  expect(output).toContain("Recent restart handoff: full-process via launchd");
  expect(output).toContain("reason=plugin source changed");
});

it.each(["newer schema", "unreadable"] as const)(
  "reports a %s database before loading deep status config, without modifying it",
  async (kind) => {
    const newer = kind === "newer schema";
    const stateDir = tempDirs.make("openclaw-status-database-refusal-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    if (newer) {
      writeDatabase(databasePath, (database) =>
        database.exec(`
          PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
          CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT);
          INSERT INTO schema_meta VALUES ('primary', '2026.9.4');
        `),
      );
    } else {
      await fs.writeFile(databasePath, "not a sqlite database ".repeat(256));
    }
    const before = await fs.readFile(databasePath);
    await useDatabasePreflight(env);
    const { run, writeJson, exit } = statusCommand();
    const log = newer ? vi.spyOn(defaultRuntime, "log").mockImplementation(() => {}) : undefined;
    const error = newer
      ? vi.spyOn(defaultRuntime, "error").mockImplementation(() => {})
      : undefined;
    try {
      await expect(run("--deep", "--no-probe", ...(newer ? [] : ["--json"]))).rejects.toThrow(
        "status-exit",
      );
      const output = newer
        ? error?.mock.calls.flat().join("\n")
        : JSON.stringify(writeJson.mock.calls);
      if (newer) {
        expect(output).toContain("Gateway refused startup");
        expect(output).toContain(`schema ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
        expect(output).toContain(`this build supports ${OPENCLAW_STATE_SCHEMA_VERSION}`);
        expect(output).toContain("writer build 2026.9.4");
        expect(output).toContain(`Refused by OpenClaw ${VERSION}`);
        expect(output).toContain("pre-upgrade backup");
        expect(readGatewayLastShutdownAsync).not.toHaveBeenCalled();
      } else {
        expect(output).toContain(`shared state database is unreadable at ${databasePath}`);
        expect(output).toContain("restore this file from a verified backup");
        expect(output).not.toContain("CONFIG_READ_FAILED");
      }
      expect(exit).toHaveBeenCalledWith(1);
      expect(createConfigIOCalls).not.toHaveBeenCalled();
      expect(await fs.readFile(databasePath)).toEqual(before);
    } finally {
      log?.mockRestore();
      error?.mockRestore();
    }
  },
);

it("keeps readable shutdown history when a registered agent database has a newer schema", async () => {
  const stateDir = tempDirs.make("openclaw-status-readable-schema-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const agentPath = path.join(stateDir, "agent.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  writeDatabase(databasePath, (database) => {
    database.exec(`BEGIN; ${OPENCLAW_STATE_SCHEMA_SQL}
        PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
        INSERT INTO gateway_boot_lifecycle VALUES
          ('prior-boot', 1, 1000, 2000, 'clean_stop', NULL, 'stop (SIGTERM)');
      `);
    database
      .prepare("INSERT INTO agent_databases VALUES ('optional', ?, ?, 1, NULL)")
      .run(agentPath, OPENCLAW_AGENT_SCHEMA_VERSION + 1);
    database.exec("COMMIT");
  });
  writeDatabase(agentPath, (agent) => {
    agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
  });
  await useDatabasePreflight(env);
  readGatewayLastShutdownAsync.mockImplementation(originalReadGatewayLastShutdown);
  const status = await gatherStatus({ deep: true, probe: false });
  expect(status.gateway?.lastShutdown).toEqual({ reason: "stop (SIGTERM)", completedAtMs: 2000 });
  expect(capturePrintedDaemonStatus(status, { json: false }).logs).toContain(
    "Last shutdown: stop (SIGTERM) at 1970-01-01T00:00:02.000Z",
  );
});

it("reports dueling systemd diagnosis for its native target", async () => {
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
  await withMockedPlatform("linux", async () => {
    const status = await gatherStatus({ probe: false, deep: true });
    const printed = capturePrintedDaemonStatus(status, { json: false, deep: true });
    const output = `${printed.logs}\n${printed.errors}`;
    expect(output.match(/they will SIGTERM each other/g)).toHaveLength(1);
    expect(output).toContain(status.gateway?.duelingScopesWarning);
    expect(output).toContain("Run `openclaw doctor` interactively");
  });
});

it.runIf(process.platform === "darwin")(
  "surfaces stale updater launchd jobs only during deep status",
  async () => {
    serviceReadCommand.mockResolvedValueOnce(
      serviceCommand({
        ...daemonEnvironment,
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
      }),
    );
    const jobs = [
      { label: "ai.openclaw.update.2026.5.12", lastExitStatus: 127 },
      { label: "ai.openclaw.manual-update.1717168800", lastExitStatus: 0 },
    ];
    findStaleOpenClawUpdateLaunchdJobs.mockResolvedValueOnce(jobs);
    const status = await gatherStatus({ probe: false, deep: true });
    const staleScanEnv = findStaleOpenClawUpdateLaunchdJobs.mock.calls[0]?.[0];
    expect(staleScanEnv).toMatchObject({
      ...daemonEnvironment,
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.gateway",
    });
    expect(status.service.staleUpdateLaunchdJobs).toEqual(jobs);
  },
);

it("surfaces foreign launchd jobs and restart correlation without --deep", async () => {
  await withMockedPlatform("darwin", async () => {
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
  });
});

it("surfaces established gateway connections during deep status", async () => {
  const connections = [
    {
      pid: 4242,
      ppid: 1,
      command: "node",
      commandLine: "node /tmp/newer-openclaw/dist/index.js logs --follow",
      address: "TCP 127.0.0.1:50123->127.0.0.1:19001 (ESTABLISHED)",
      direction: "client" as const,
    },
  ];
  inspectPortConnections.mockResolvedValueOnce({ port: 19001, connections });
  const status = await gatherStatus({ probe: false, deep: true });
  expect(inspectPortConnections).toHaveBeenCalledWith(19001);
  expect(status.connections?.established).toEqual(connections);
  const output = capturePrintedDaemonStatus(status, { json: false }).logs;
  expect(output).toContain("Established clients: 1");
  expect(output).toContain("pid=4242");
  expect(output).toContain("newer-openclaw");
  expect(output).toContain("client");
  expect(output).toContain("protocol mismatch after rollback");
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
  await withStatusConfig(JSON.stringify({ gateway: { bind: "loopback" } }), async (configPath) => {
    const warning = "without channelConfigs metadata";
    cliConfigWarnings = [{ path: "plugins.entries.test-bad-plugin", message: warning }];
    const status = await gatherStatus({ probe: false, deep: true });
    expect(createConfigIOCalls).toHaveBeenCalledWith(configPath, "full", false);
    expect(readConfigFileSnapshotCalls).toHaveBeenCalledWith(configPath);
    expect(status.config?.cli.warnings).toEqual(cliConfigWarnings);
    const output = capturePrintedDaemonStatus(status, { json: false }).errors;
    expect(output).toContain("Config warnings:");
    expect(output).toContain(warning);
    expect(status.config?.daemon).toBe(status.config?.cli);
  });
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
      auth: { mode: "token", token: execRef("gateway/credential") },
    },
    secrets: execSecrets,
  };
  const status = await gatherStatus({ allowExecSecretRefs: false });
  expect(probeAuthCalls).not.toHaveBeenCalled();
  const input = probeInput();
  expect(input).toMatchObject({
    token: undefined,
    password: undefined,
    allowRpcConfigCredentials: false,
  });
  expect(status.rpc?.authWarning).toContain(
    "gateway credentials use an exec SecretRef and exec SecretRefs are disabled",
  );
});

it("surfaces stale gateway listener pids from restart health inspection when probe fails", async () => {
  serviceReadRuntime.mockResolvedValueOnce({ status: "running", pid: 8000 });
  callGatewayStatusProbe.mockResolvedValueOnce(failedProbe("timeout"));
  inspectGatewayRestart.mockResolvedValueOnce({
    runtime: { status: "running", pid: 8000 },
    portUsage: portUsage(19001, [{ pid: 9000, ppid: 8999, commandLine: "openclaw-gateway" }]),
    healthy: false,
    staleGatewayPids: [9000],
  });
  const status = await gatherStatus();
  expect(inspectGatewayRestart.mock.calls[0]?.[0]).toMatchObject({ port: 19001 });
  expect(status.health).toEqual({ healthy: false, staleGatewayPids: [9000] });
  const output = capturePrintedDaemonStatus(status, { json: false });
  expect(output.errors).toContain("Gateway runtime PID does not own the listening port");
  expect(output.errors).toContain("openclaw gateway restart");
  expect(output.logs).toContain("Readiness is not confirmed");
  expect(output.logs).not.toContain("Warm-up:");
  expect(output.logs).not.toContain("Gateway process is running and owns the gateway port");
});

it("includes the last gateway error when the service is listening but the RPC probe fails", async () => {
  inspectPortUsages.mockResolvedValueOnce(
    new Map([[19001, portUsage(19001, [{ pid: 8000, ppid: 1, commandLine: "openclaw gateway" }])]]),
  );
  callGatewayStatusProbe.mockResolvedValueOnce(
    failedProbe("gateway closed (1000): ", "wss://127.0.0.1:19001"),
  );
  readLastGatewayErrorLine.mockResolvedValueOnce(
    "parse/handle error: Error: ENOSPC: no space left on device, write",
  );
  const status = await gatherStatus();
  expect(readLastGatewayErrorLine.mock.calls[0]?.[0]).toMatchObject(daemonEnvironment);
  expect(status.port?.status).toBe("busy");
  expect(status.rpc?.ok).toBe(false);
  expect(status.lastError).toBe(
    "parse/handle error: Error: ENOSPC: no space left on device, write",
  );
  const output = capturePrintedDaemonStatus(status, { json: false }).errors;
  expect(output).toContain("Connectivity check: failed");
  expect(output).toContain("gateway closed (1000):");
  expect(output).toContain(
    "Recent Gateway log error (may be from an earlier run): parse/handle error: Error: ENOSPC: no space left on device, write",
  );
});

it("compares plugin drift against the running gateway version from the probe, not the CLI VERSION", async () => {
  callGatewayStatusProbe.mockResolvedValueOnce({
    ok: true,
    url: "ws://127.0.0.1:19001",
    error: null,
    server: { version: "2026.5.4", connId: "c1" },
  });
  installedPlugins.mockResolvedValueOnce({
    brave: {
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.5.3",
      resolvedName: "@openclaw/brave-plugin",
      resolvedVersion: "2026.5.3",
    },
    whatsapp: npmPlugin("whatsapp", "2026.5.4"),
  });
  const status = await gatherStatus();
  expect(status.pluginVersionDrift?.gatewayVersion).toBe("2026.5.4");
  expect(status.pluginVersionDrift?.drifts.map((drift) => drift.pluginId)).toEqual(["brave"]);
  expect(status.pluginVersionDrift?.drifts[0]?.targetResolution).toBeUndefined();
  const output = capturePrintedDaemonStatus(status, { json: false }).logs;
  expect(output).toContain("Plugin version drift: 1 active official plugin");
  expect(output).toContain("openclaw gateway status --deep");
  expect(output).not.toContain("brave:");
  expect(fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
  expect(installedPlugins.mock.calls[0]?.[0]?.env).toMatchObject({
    OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
  });
});

it.each([
  { name: "running an older version", runtime: "running", probeVersion: "2026.5.4" },
  { name: "stopped", runtime: "stopped", probeVersion: undefined },
])(
  "compares Doctor plugin readiness with the installed service when the Gateway is $name",
  async ({ runtime, probeVersion }) => {
    const packageRoot = await fs.realpath(tempDirs.make("openclaw-restart-readiness-"));
    await fs.mkdir(path.join(packageRoot, "dist"));
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.6.1" }),
    );
    const entrypoint = path.join(packageRoot, "dist", "index.js");
    await fs.writeFile(entrypoint, "gateway");
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: [process.execPath, entrypoint, "gateway", "run"],
      environment: daemonEnvironment,
    });
    serviceReadRuntime.mockResolvedValueOnce({ status: runtime });
    callGatewayStatusProbe.mockResolvedValueOnce(
      probeVersion
        ? { ok: true, server: { version: probeVersion, connId: "c1" } }
        : { ok: false, error: "connect failed" },
    );
    installedPlugins.mockResolvedValueOnce(whatsappPlugins);
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
  },
);

it.each([
  ["package version is unavailable", false],
  ["service command is unavailable", true],
] as const)("reports unresolved restart readiness when %s", async (reason, missingCommand) => {
  if (missingCommand) {
    serviceReadCommand.mockResolvedValueOnce(null);
  }
  installedPlugins.mockResolvedValueOnce(whatsappPlugins);
  const status = await gatherStatus({ pluginVersionTarget: "restart" });
  expect(status.pluginVersionRestartReadiness).toEqual({
    status: "unresolved",
    reason: expect.stringContaining(reason),
    runningGatewayVersion: "2026.5.6",
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
