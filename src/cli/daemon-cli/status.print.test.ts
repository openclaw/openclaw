import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { formatCliCommand } from "../command-format.js";
import type { DaemonStatus } from "./status.gather.js";
import { registerServiceInspectionHintTests } from "./status.print.inspection.test-support.js";
import { printDaemonStatus as printDaemonStatusRuntime } from "./status.print.js";

type StatusFixture = Omit<Partial<DaemonStatus>, "service"> & {
  service?: Partial<DaemonStatus["service"]>;
  platform?: NodeJS.Platform;
  json?: boolean;
  deep?: boolean;
};
function printDaemonStatus({ platform, json = false, deep, ...status }: StatusFixture) {
  const serviceState = { ...service, ...status.service };
  const loaded =
    serviceState.loadState.status === "unknown" ? null : serviceState.loadState.status === "loaded";
  withMockedPlatform(platform ?? process.platform, () =>
    printDaemonStatusRuntime(
      { extraServices: [], ...status, service: { ...serviceState, loaded } },
      { json, deep },
    ),
  );
}
function commandEnv(environment: GatewayServiceCommandConfig["environment"]) {
  return { programArguments: [], environment };
}
const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
  writeJson: vi.fn<(value: unknown) => void>(),
}));
const mocks = vi.hoisted(() => ({
  links: vi.fn((_opts?: unknown) => ({ httpUrl: "http://127.0.0.1:18789" })),
  unavailable: vi.fn(() => false),
  unavailableHints: vi.fn<() => string[]>(() => []),
  cleanupHints: vi.fn<(_services: readonly ExtraGatewayService[]) => string[]>(() => []),
  wsl: vi.fn((env?: Record<string, string | undefined>) => Boolean(env?.WSL_DISTRO_NAME)),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock(import("../../../packages/terminal-core/src/theme.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  colorize: (_rich: boolean, _theme: unknown, text: string) => text,
}));
vi.mock("../../gateway/control-ui-links.js", () => ({ resolveControlUiLinks: mocks.links }));
vi.mock("../../daemon/inspect.js", () => ({
  renderGatewayServiceCleanupHints: mocks.cleanupHints,
}));
// mock-isolation: Keep status fixtures independent of the operator's log paths.
vi.mock("../../daemon/restart-logs.js", () => ({
  resolveGatewaySupervisorLogPaths: () => ({
    logDir: "/Users/test/Library/Logs/openclaw",
    stdoutPath: "/Users/test/Library/Logs/openclaw/gateway.log",
    stderrPath: "/Users/test/Library/Logs/openclaw/gateway.err.log",
  }),
  resolveGatewayRestartLogPath: () => "/tmp/gateway-restart.log",
}));
vi.mock("../../daemon/systemd-hints.js", () => ({
  isSystemdUnavailableDetail: mocks.unavailable,
  renderSystemdUnavailableHints: mocks.unavailableHints,
}));
vi.mock("../../infra/wsl.js", () => ({ isWSLEnv: mocks.wsl }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  safeDaemonEnv: () => [],
}));
vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => ["127.0.0.1:18789"],
}));
const service: DaemonStatus["service"] = {
  label: "LaunchAgent",
  loaded: true,
  loadState: { status: "loaded" },
  loadedText: "loaded",
  notLoadedText: "not loaded",
};
const runningService = { runtime: { status: "running" as const, pid: 8000 } };
const gateway: NonNullable<DaemonStatus["gateway"]> = {
  bindMode: "loopback",
  bindHost: "127.0.0.1",
  port: 18789,
  portSource: "env/config",
  probeUrl: "ws://127.0.0.1:18789",
};
const freePort = { port: 18789, status: "free" as const, listeners: [], hints: [] };
function configFile(file: string, controlUi?: { basePath: string }) {
  return { path: file, exists: true, valid: true, controlUi };
}
function output(mock = runtime.log) {
  return mock.mock.calls.flat().join("\n");
}
function expectText(mock: typeof runtime.log, ...expected: string[]) {
  for (const text of expected) {
    expect(output(mock)).toContain(text);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cleanupHints.mockReset().mockReturnValue([]);
  mocks.unavailable.mockReset().mockReturnValue(false);
  mocks.unavailableHints.mockReset().mockReturnValue([]);
});

it("preserves Gateway metadata and input while redacting private definitions in JSON", () => {
  const server = { version: "2026.5.6", buildId: "build-2026.5.6", connId: "conn-1" };
  const extraService: ExtraGatewayService = {
    platform: "linux",
    label: "sibling.service",
    detail: "unit: /etc/systemd/system/sibling.service",
    sourcePath: "/etc/systemd/system/sibling.service",
    scope: "system",
  };
  const command: GatewayServiceCommandConfig = {
    programArguments: ["node"],
    environment: { OPENCLAW_STATE_DIR: "/tmp", OPENCLAW_GATEWAY_TOKEN: "effective-gateway-token" },
    managedDefinition: commandEnv({ OPENCLAW_GATEWAY_TOKEN: "managed-base-gateway-token" }),
    managedOverrides: { launcher: "command", environment: { keys: ["OPENCLAW_GATEWAY_TOKEN"] } },
    definitionPaths: ["/etc/systemd/user/private-definition.conf"],
    reloadPending: true,
  };
  const original = structuredClone(command);
  printDaemonStatus({
    json: true,
    deep: true,
    service: { command },
    rpc: { ok: true, server },
    extraServices: [extraService],
  });
  expect(runtime.writeJson).toHaveBeenCalledOnce();
  const payload = runtime.writeJson.mock.calls[0]?.[0];
  const { sourcePath, ...publicService } = extraService;
  expect(payload).toHaveProperty("rpc.server", server);
  expect(payload).toHaveProperty("extraServices", [publicService]);
  expect(sourcePath).toBe("/etc/systemd/system/sibling.service");
  expect(payload).not.toHaveProperty("service.command.managedDefinition");
  expect(payload).not.toHaveProperty("service.command.managedOverrides");
  expect(payload).not.toHaveProperty("service.command.definitionPaths");
  expect(payload).toHaveProperty("service.command.reloadPending", true);
  expect(JSON.stringify(payload)).not.toContain("gateway-token");
  expect(command).toEqual(original);
});

it.each([
  ["user", "systemctl --user"],
  ["system", "sudo systemctl --system"],
] as const)(
  "prints %s-manager pending reload guidance after the service file",
  (scope, command) => {
    printDaemonStatus({
      platform: "linux",
      service: {
        label: "systemd",
        runtime: { status: "running", systemd: { scope, unit: "openclaw.service" } },
        command: { programArguments: ["node"], sourcePath: "/tmp/unit", reloadPending: true },
      },
      port: freePort,
    });
    const lines = runtime.log.mock.calls.map(([line]) => line);
    const serviceFileIndex = lines.findIndex((line) => line.startsWith("Service file:"));
    expect(lines[serviceFileIndex + 1]).toBe(
      `Systemd reload: pending (run ${command} daemon-reload)`,
    );
    expectText(runtime.error, `Logs: journalctl --${scope} -u openclaw.service`);
  },
);

it.skipIf(process.platform !== "win32")(
  "shortens real Windows home casing aliases in human status",
  async () => {
    await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
      const logFile = path.join(home, "logs", "gateway.log");
      await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
      await fs.promises.writeFile(logFile, "ready", "utf8");
      const logFileAlias = logFile.toUpperCase();
      expect(fs.statSync(logFileAlias).isFile()).toBe(true);
      await withEnv({ OPENCLAW_HOME: home }, async () => {
        printDaemonStatus({
          service: {
            label: "Scheduled Task",
            loadedText: "registered",
            notLoadedText: "not registered",
          },
          logFile: logFileAlias,
        });
      });
      expectText(runtime.log, `File logs: $OPENCLAW_HOME${path.sep}LOGS${path.sep}GATEWAY.LOG`);
      expect(output()).not.toContain(home.toUpperCase());
    });
  },
);

it("uses service command env for WSL systemd unavailable hints", () => {
  mocks.unavailable.mockReturnValue(true);
  mocks.unavailableHints.mockReturnValue(["wsl hint"]);
  const unavailable = {
    status: "unknown" as const,
    detail: "System has not been booted with systemd as init system",
  };
  printDaemonStatus({
    platform: "linux",
    service: {
      label: "systemd",
      loadState: unavailable,
      runtime: unavailable,
      command: commandEnv({ WSL_DISTRO_NAME: "Ubuntu" }),
    },
    rpc: { ok: false, error: "unavailable", url: gateway.probeUrl },
  });
  expect(mocks.wsl).toHaveBeenCalledWith({ WSL_DISTRO_NAME: "Ubuntu" });
  expect(mocks.unavailableHints).toHaveBeenCalledWith({
    wsl: true,
    kind: "generic_unavailable",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
  });
  expectText(runtime.log, "Service: systemd (unknown)");
  expect(output()).not.toContain("Service: systemd (not loaded)");
  expectText(runtime.error, "wsl hint");
});

it("reports non-lifecycle launchd jobs without warnings", () => {
  const job = {
    label: "ai.openclaw.test.w15.other",
    program: "/tmp/openclaw-test/other.sh",
    keepAlive: false,
    gatewayActions: [],
    safeToRemove: false,
  };
  printDaemonStatus({
    service: {
      ...runningService,
      foreignLaunchdJobs: [job],
      forcedRestartSummary: { count: 3, windowMs: 600_000 },
    },
  });
  expectText(
    runtime.log,
    "Other OpenClaw launchd jobs (macOS)",
    job.label,
    job.program,
    "Report only; left unchanged.",
  );
  expect(runtime.error).not.toHaveBeenCalled();
  expect(output()).not.toContain("Listed lifecycle jobs may be responsible");
});

it("prints stale updater launchd job guidance", () => {
  printDaemonStatus({
    service: {
      ...runningService,
      staleUpdateLaunchdJobs: [
        { label: "ai.openclaw.update.2026.5.12", lastExitStatus: 127 },
        { label: "ai.openclaw.manual-update.1717168800", lastExitStatus: 0 },
      ],
    },
    gateway,
  });
  expectText(
    runtime.error,
    "Stale OpenClaw updater launchd job(s) detected.",
    "ai.openclaw.update.2026.5.12",
    "ai.openclaw.manual-update.1717168800",
    "launchctl remove <label>",
    formatCliCommand("openclaw gateway restart"),
  );
});

it("points macOS launchd stdout and stderr at one log when gateway is not listening", () => {
  printDaemonStatus({
    platform: "darwin",
    service: { ...runningService, command: commandEnv({ HOME: "/Users/test" }) },
    gateway,
    port: freePort,
    rpc: { ok: false, kind: "connect", error: "gateway closed (1000): " },
    lastError: "failed to bind gateway socket EADDRINUSE",
  });
  expectText(
    runtime.error,
    "Gateway port 18789 is not listening",
    "/Users/test/Library/Logs/openclaw/gateway.log",
    "Logs (stdout and stderr):",
  );
  expect(output()).not.toContain("Warm-up:");
  expect(output()).toContain("Readiness is not confirmed");
  const errors = output(runtime.error);
  expect(errors).not.toContain("suppressed");
  expect(errors.match(/Recent Gateway log error/g)).toHaveLength(1);
  expect(errors).toContain("may be from an earlier run");
});

it("names a disabled custom Scheduled Task and explains how to re-enable it", () => {
  printDaemonStatus({
    platform: "win32",
    service: {
      label: "Scheduled Task",
      loadedText: "registered",
      notLoadedText: "not registered",
      runtime: { status: "stopped", state: "Disabled" },
      command: commandEnv({ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Custom Gateway" }),
    },
  });
  const errors = output(runtime.error);
  expectText(
    runtime.error,
    "Scheduled Task 'OpenClaw Custom Gateway' is registered but DISABLED",
    "openclaw gateway start",
    "openclaw doctor --fix",
    "to re-enable it",
    'schtasks /Query /TN "OpenClaw Custom Gateway"',
  );
  expect(errors).not.toContain("likely exited immediately");
});

it("prints GUI-session recovery guidance for the service profile", () => {
  printDaemonStatus({
    service: {
      loadState: { status: "not-loaded" },
      runtime: { status: "unknown", missingGuiSession: true },
      command: commandEnv({ OPENCLAW_PROFILE: "work" }),
    },
  });
  expectText(
    runtime.error,
    "macOS has no usable GUI session",
    "logged-in macOS GUI session",
    "openclaw --profile work gateway restart",
  );
});

it("prints connectivity and capability without a service config summary", () => {
  printDaemonStatus({
    service: runningService,
    config: { cli: configFile("/tmp/openclaw.json") },
    gateway,
    rpc: { ok: true, kind: "connect", capability: "write_capable", url: gateway.probeUrl },
  });
  expectText(runtime.log, "Connectivity check: ok");
  expect(
    runtime.log.mock.calls.map(([line]) => line).filter((line) => line.startsWith("Capability:")),
  ).toEqual(["Capability: write-capable"]);
  expect(output(runtime.error)).not.toContain("doctor --fix");
});

it("passes daemon TLS state to dashboard link rendering", () => {
  printDaemonStatus({
    service: runningService,
    config: {
      cli: configFile("/tmp/openclaw-cli/openclaw.json"),
      daemon: configFile("/tmp/openclaw-daemon/openclaw.json", { basePath: "/ui" }),
      mismatch: true,
    },
    gateway: {
      ...gateway,
      bindMode: "lan",
      bindHost: "0.0.0.0",
      port: 19001,
      probeUrl: "wss://127.0.0.1:19001",
      tlsEnabled: true,
    },
  });
  expect(mocks.links).toHaveBeenCalledWith({
    port: 19001,
    bind: "lan",
    customBindHost: undefined,
    basePath: "/ui",
    tlsEnabled: true,
  });
});

it("prints extra gateways as warnings with cleanup scoped to the detected gateway", () => {
  const extraService = {
    platform: "darwin" as const,
    label: "com.example.openclaw-gateway",
    scope: "user" as const,
    detail: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
  };
  mocks.cleanupHints.mockReturnValue([
    "launchctl bootout gui/$UID/com.example.openclaw-gateway",
    "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
  ]);
  printDaemonStatus({ service: runningService, extraServices: [extraService] });
  expect(runtime.error).not.toHaveBeenCalled();
  expectText(runtime.log, "Other gateway-like services detected");
  expect(mocks.cleanupHints).toHaveBeenCalledWith([extraService]);
  expectText(runtime.log, "Cleanup hint: launchctl bootout gui/$UID/com.example.openclaw-gateway");
  expect(output()).not.toContain("ai.openclaw.gateway");
});

registerServiceInspectionHintTests({ renderHints: mocks.cleanupHints, output });

it.each([
  { lastExitStatus: undefined, exhausted: true },
  { lastExitStatus: 78, exhausted: false },
])(
  "distinguishes systemd crash exhaustion from config exit $lastExitStatus",
  ({ lastExitStatus, exhausted }) => {
    printDaemonStatus({
      platform: "linux",
      service: {
        label: "systemd",
        runtime: {
          status: "stopped",
          state: "failed",
          lastExitStatus,
          systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
        },
      },
    });
    const errors = output(runtime.error);
    expect(errors.includes("systemd stopped restarting the gateway after repeated crashes")).toBe(
      exhausted,
    );
    expect(errors.includes("Service is loaded but not running (likely exited immediately).")).toBe(
      !exhausted,
    );
  },
);

type Drift = NonNullable<DaemonStatus["pluginVersionDrift"]>["drifts"][number];
function printDrift(overrides: Partial<Drift>) {
  const entry: Drift = {
    pluginId: "whatsapp",
    installedVersion: "2026.9.2",
    gatewayVersion: "2026.9.4",
    source: "clawhub",
    ...overrides,
  };
  printDaemonStatus({
    deep: true,
    service: runningService,
    pluginVersionDrift: { gatewayVersion: entry.gatewayVersion, drifts: [entry] },
  });
}

it.each(["resolved", "registry-current"] as const)(
  "prints the %s ClawHub repair target",
  (status) => {
    const current = status === "registry-current";
    printDrift({
      installedVersion: current ? "2026.9.3" : "2026.9.2",
      targetResolution: {
        status,
        packageName: "@openclaw/whatsapp",
        requestedTarget: current ? "2026.9.4" : "latest",
        version: "2026.9.3",
      },
    });
    if (current) {
      expectText(
        runtime.log,
        "- whatsapp: 2026.9.3 (clawhub) → expected 2026.9.4",
        "registry version 2026.9.3 is already installed; no release reaches 2026.9.4 yet",
      );
      expect(output()).not.toContain("openclaw plugins update");
    } else {
      expectText(
        runtime.log,
        "- whatsapp: 2026.9.2 (clawhub)",
        "expected 2026.9.3; clawhub target @openclaw/whatsapp@2026.9.3",
        `Fix: ${formatCliCommand("openclaw plugins update whatsapp")} && ${formatCliCommand("openclaw gateway restart")}.`,
      );
      expect(output()).not.toContain("expected 2026.9.4");
    }
    expect(output(runtime.error)).not.toContain("Plugin repair target resolution failed");
  },
);

it("fails loudly without an install command when npm cannot resolve a pinned target", () => {
  printDrift({
    pluginId: "brave",
    installedVersion: "2026.7.1-beta.2",
    gatewayVersion: "2026.7.1-2",
    source: "npm",
    packageName: "@openclaw/brave-plugin",
    spec: "@openclaw/brave-plugin@2026.7.1-beta.2",
    targetResolution: {
      status: "unresolved",
      packageName: "@openclaw/brave-plugin",
      requestedTarget: "2026.7.1",
      error: "npm registry did not resolve @openclaw/brave-plugin@2026.7.1: HTTP 404",
    },
  });
  expectText(runtime.error, "Plugin repair target resolution failed", "HTTP 404");
  const combinedOutput = [output(), output(runtime.error)].join("\n");
  expect(combinedOutput).not.toContain("openclaw plugins update");
  expect(combinedOutput).not.toContain("openclaw gateway restart");
});
it("reports an admitted probe timeout as event-loop saturation instead of failed connectivity", () => {
  printDaemonStatus({
    deep: true,
    service: runningService,
    rpc: {
      ok: false,
      kind: "read",
      gatewayReached: true,
      timedOut: true,
      eventLoop: {
        degraded: true,
        reasons: ["event_loop_delay", "event_loop_utilization"],
        intervalMs: 5_000,
        delayP99Ms: 5_079,
        delayMaxMs: 5_100,
        utilization: 1,
        cpuCoreRatio: 0.94,
      },
    },
  });
  const errors = output(runtime.error);
  const logs = output();
  expect(errors).toContain("Read check: timed out under event-loop load");
  expect(errors).toContain("Gateway event loop: degraded max=5100ms p99=5079ms util=1 cpu=0.94");
  expect(logs).toContain("Gateway accepted the connection");
  expect(errors).not.toContain("Connectivity check: failed");
  expect(logs).not.toContain("not a warm-up delay");
});
it("does not warn about the service install when it matches the CLI version", () => {
  printDaemonStatus({
    cli: { version: "2026.6.35", entrypoint: "/home/ops/.local/bin/openclaw" },
    service: {
      layout: {
        execStart: "/usr/bin/node /tmp/openclaw/dist/index.js gateway",
        packageRoot: "/home/ops/.local/lib/node_modules/openclaw",
        packageVersion: "2026.6.35",
      },
    },
  });
  expectText(runtime.log, "Gateway service version: 2026.6.35");
  expect(output(runtime.error)).not.toContain("installed Gateway service is version");
});
