// Daemon status print tests cover user-facing service status formatting.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnv } from "../../test-utils/env.js";
import { formatCliCommand } from "../command-format.js";
import type { DaemonStatus } from "./status.gather.js";
import { registerServiceInspectionHintTests } from "./status.print.inspection.test-support.js";
import { printDaemonStatus as printDaemonStatusRuntime } from "./status.print.js";

type StatusFixture = Omit<Partial<DaemonStatus>, "service"> & {
  service?: Partial<DaemonStatus["service"]>;
};

function printDaemonStatus(
  status: StatusFixture,
  options: Parameters<typeof printDaemonStatusRuntime>[1] = { json: false },
) {
  const serviceState = { ...service, ...status.service };
  const loaded =
    status.service?.loaded !== undefined
      ? status.service.loaded
      : serviceState.loadState.status === "unknown"
        ? null
        : serviceState.loadState.status === "loaded";
  printDaemonStatusRuntime(
    { extraServices: [], ...status, service: { ...serviceState, loaded } },
    options,
  );
}

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
  writeJson: vi.fn<(value: unknown) => void>(),
}));
const resolveControlUiLinksMock = vi.hoisted(() =>
  vi.fn((_opts?: unknown) => ({ httpUrl: "http://127.0.0.1:18789" })),
);
const isSystemdUnavailableDetailMock = vi.hoisted(() => vi.fn(() => false));
const renderSystemdUnavailableHintsMock = vi.hoisted(() => vi.fn<() => string[]>(() => []));
const renderGatewayServiceCleanupHintsMock = vi.hoisted(() =>
  vi.fn<(_services: readonly ExtraGatewayService[]) => string[]>(() => []),
);
const isWSLEnvMock = vi.hoisted(() =>
  vi.fn((env?: Record<string, string | undefined>) => Boolean(env?.WSL_DISTRO_NAME)),
);

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../../../packages/terminal-core/src/theme.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/terminal-core/src/theme.js")
  >("../../../packages/terminal-core/src/theme.js");
  return {
    ...actual,
    colorize: (_rich: boolean, _theme: unknown, text: string) => text,
  };
});

vi.mock("../../gateway/control-ui-links.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
}));

vi.mock("../../daemon/inspect.js", () => ({
  renderGatewayServiceCleanupHints: renderGatewayServiceCleanupHintsMock,
}));

vi.mock("../../daemon/restart-logs.js", () => ({
  resolveGatewayLogPaths: () => ({
    logDir: "/tmp",
    stdoutPath: "/tmp/gateway.out.log",
    stderrPath: "/tmp/gateway.err.log",
  }),
  resolveGatewaySupervisorLogPaths: () => ({
    logDir: "/Users/test/Library/Logs/openclaw",
    stdoutPath: "/Users/test/Library/Logs/openclaw/gateway.log",
    stderrPath: "/Users/test/Library/Logs/openclaw/gateway.err.log",
  }),
  resolveGatewayRestartLogPath: () => "/tmp/gateway-restart.log",
}));

vi.mock("../../daemon/systemd-hints.js", () => ({
  isSystemdUnavailableDetail: isSystemdUnavailableDetailMock,
  renderSystemdUnavailableHints: renderSystemdUnavailableHintsMock,
}));

vi.mock("../../infra/wsl.js", () => ({
  isWSLEnv: isWSLEnvMock,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (text: string) => text,
    accent: (text: string) => text,
    infoText: (text: string) => text,
    okText: (text: string) => text,
    warnText: (text: string) => text,
    errorText: (text: string) => text,
  }),
  resolveRuntimeStatusColor: () => "",
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
const runningService: Partial<DaemonStatus["service"]> = {
  runtime: { status: "running", pid: 8000 },
};
const gateway: NonNullable<DaemonStatus["gateway"]> = {
  bindMode: "loopback",
  bindHost: "127.0.0.1",
  port: 18789,
  portSource: "env/config",
  probeUrl: "ws://127.0.0.1:18789",
};

function emptyPort(
  status: NonNullable<DaemonStatus["port"]>["status"],
): NonNullable<DaemonStatus["port"]> {
  return { port: 18789, status, listeners: [], hints: [] };
}

describe("printDaemonStatus", () => {
  function output(mock = runtime.log) {
    return mock.mock.calls.flat().join("\n");
  }
  function expectMockLineContains(mock: typeof runtime.log, expected: string) {
    expect(output(mock)).toContain(expected);
  }

  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.writeJson.mockReset();
    renderGatewayServiceCleanupHintsMock.mockReset().mockReturnValue([]);
    resolveControlUiLinksMock.mockClear();
    isSystemdUnavailableDetailMock.mockReset().mockReturnValue(false);
    renderSystemdUnavailableHintsMock.mockReset().mockReturnValue([]);
    isWSLEnvMock.mockClear();
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
      environment: {
        OPENCLAW_STATE_DIR: "/tmp",
        OPENCLAW_GATEWAY_TOKEN: "effective-gateway-token",
      },
      managedDefinition: {
        programArguments: ["node"],
        environment: { OPENCLAW_GATEWAY_TOKEN: "managed-base-gateway-token" },
      },
      managedOverrides: { launcher: "command", environment: { keys: ["OPENCLAW_GATEWAY_TOKEN"] } },
      definitionPaths: ["/etc/systemd/user/private-definition.conf"],
      reloadPending: true,
    };
    const original = structuredClone(command);
    printDaemonStatus(
      { service: { command }, rpc: { ok: true, server }, extraServices: [extraService] },
      { json: true, deep: true },
    );
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const payload = runtime.writeJson.mock.calls[0]?.[0];
    expect(payload).toHaveProperty("rpc.server", server);
    expect(payload).toHaveProperty("extraServices", [
      {
        platform: "linux",
        label: "sibling.service",
        detail: "unit: /etc/systemd/system/sibling.service",
        scope: "system",
      },
    ]);
    expect(extraService.sourcePath).toBe("/etc/systemd/system/sibling.service");
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
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
      try {
        printDaemonStatus({
          service: {
            label: "systemd",
            runtime: { status: "running", systemd: { scope, unit: "openclaw.service" } },
            command: {
              programArguments: ["node"],
              sourcePath: `${scope === "user" ? "/home/test/.config/systemd/user" : "/etc/systemd/system"}/openclaw.service`,
              reloadPending: true,
            },
          },
          port: emptyPort("free"),
        });
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }

      const lines = runtime.log.mock.calls.map(([line]) => line);
      const serviceFileIndex = lines.findIndex((line) => line.startsWith("Service file:"));
      expect(lines[serviceFileIndex + 1]).toBe(
        `Systemd reload: pending (run ${command} daemon-reload)`,
      );
      expectMockLineContains(runtime.error, `Logs: journalctl --${scope} -u openclaw.service`);
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
              loadState: { status: "loaded" },
              loadedText: "registered",
              notLoadedText: "not registered",
            },
            logFile: logFileAlias,
          });
        });

        expectMockLineContains(
          runtime.log,
          `File logs: $OPENCLAW_HOME${path.sep}LOGS${path.sep}GATEWAY.LOG`,
        );
        expect(output()).not.toContain(home.toUpperCase());
      });
    },
  );

  it("uses service command env for WSL systemd unavailable hints", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    isSystemdUnavailableDetailMock.mockReturnValue(true);
    renderSystemdUnavailableHintsMock.mockReturnValue(["wsl hint"]);
    try {
      printDaemonStatus({
        service: {
          label: "systemd",
          loadState: {
            status: "unknown",
            detail: "System has not been booted with systemd as init system",
          },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: {
            status: "unknown",
            detail: "System has not been booted with systemd as init system",
          },
          command: {
            programArguments: [],
            environment: { WSL_DISTRO_NAME: "Ubuntu" },
          },
        },
        rpc: {
          ok: false,
          error: "unavailable",
          url: "ws://127.0.0.1:18789",
        },
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expect(isWSLEnvMock).toHaveBeenCalledWith({ WSL_DISTRO_NAME: "Ubuntu" });
    expect(renderSystemdUnavailableHintsMock).toHaveBeenCalledWith({
      wsl: true,
      kind: "generic_unavailable",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
    });
    expectMockLineContains(runtime.log, "Service: systemd (unknown)");
    expect(output()).not.toContain("Service: systemd (not loaded)");
    expectMockLineContains(runtime.error, "wsl hint");
  });

  it.each([
    { name: "report-only", keepAlive: false, gatewayActions: [], warning: false },
    {
      name: "lifecycle",
      keepAlive: false,
      gatewayActions: ["restart" as const],
      warning: true,
    },
  ])("uses the appropriate status severity for $name jobs", (testCase) => {
    const job = {
      label: "ai.openclaw.test.w15.other",
      program: "/tmp/openclaw-test/other.sh",
      keepAlive: testCase.keepAlive,
      gatewayActions: testCase.gatewayActions,
      safeToRemove: false,
    };
    printDaemonStatus({
      service: {
        runtime: { status: "running", pid: 8000 },
        foreignLaunchdJobs: [job],
        forcedRestartSummary: { count: 3, windowMs: 600_000 },
      },
    });

    const report = testCase.warning ? runtime.error : runtime.log;
    const otherOutput = testCase.warning ? runtime.log : runtime.error;
    expectMockLineContains(
      report,
      testCase.warning
        ? "Foreign launchd jobs detected (macOS)."
        : "Other OpenClaw launchd jobs (macOS)",
    );
    expectMockLineContains(report, job.label);
    expectMockLineContains(report, job.program);
    expectMockLineContains(report, "Report only; left unchanged.");
    expect(output(otherOutput)).not.toContain(job.label);
    if (!testCase.warning) {
      expect(runtime.error).not.toHaveBeenCalled();
      expect(output()).not.toContain("Listed lifecycle jobs may be responsible");
    }
  });

  it("prints stale updater launchd job guidance", () => {
    printDaemonStatus({
      service: {
        runtime: { status: "running", pid: 8000 },
        staleUpdateLaunchdJobs: [
          {
            label: "ai.openclaw.update.2026.5.12",
            lastExitStatus: 127,
          },
          {
            label: "ai.openclaw.manual-update.1717168800",
            lastExitStatus: 0,
          },
        ],
      },
      gateway,
    });

    expectMockLineContains(runtime.error, "Stale OpenClaw updater launchd job(s) detected.");
    expectMockLineContains(runtime.error, "ai.openclaw.update.2026.5.12");
    expectMockLineContains(runtime.error, "ai.openclaw.manual-update.1717168800");
    expectMockLineContains(runtime.error, "launchctl remove <label>");
    expectMockLineContains(runtime.error, formatCliCommand("openclaw gateway restart"));
  });

  it("points macOS launchd stdout and stderr at one log when gateway is not listening", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      printDaemonStatus({
        service: {
          runtime: { status: "running", pid: 8000 },
          command: { programArguments: [], environment: { HOME: "/Users/test" } },
        },
        gateway,
        port: emptyPort("free"),
        rpc: {
          ok: false,
          kind: "connect",
          capability: "unknown",
          error: "gateway closed (1000): ",
          url: "ws://127.0.0.1:18789",
        },
        lastError: "failed to bind gateway socket EADDRINUSE",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expectMockLineContains(runtime.error, "Gateway port 18789 is not listening");
    expectMockLineContains(runtime.error, "/Users/test/Library/Logs/openclaw/gateway.log");
    expectMockLineContains(runtime.error, "Logs (stdout and stderr):");
    const errors = output(runtime.error);
    expect(errors).not.toContain("suppressed");
    expect(errors.match(/Last gateway error:/g)).toHaveLength(1);
  });

  it("does not claim an indeterminate port is not listening", () => {
    printDaemonStatus({
      service: {
        label: "Scheduled Task",
        loadState: { status: "loaded" },
        loadedText: "registered",
        notLoadedText: "not registered",
        runtime: { status: "running", pid: 8000 },
      },
      gateway,
      port: emptyPort("unknown"),
      rpc: {
        ok: false,
        kind: "connect",
        capability: "unknown",
        error: "gateway closed (1000): ",
        url: "ws://127.0.0.1:18789",
      },
    });

    const errors = output(runtime.error);
    expect(errors).not.toContain("Gateway port 18789 is not listening");
  });

  it("names a disabled custom Scheduled Task and explains how to re-enable it", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      printDaemonStatus({
        service: {
          label: "Scheduled Task",
          loadedText: "registered",
          notLoadedText: "not registered",
          runtime: { status: "stopped", state: "Disabled" },
          command: {
            programArguments: [],
            environment: { OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Custom Gateway" },
          },
        },
      });
    } finally {
      platform.mockRestore();
    }

    const errors = output(runtime.error);
    expect(errors).toContain("Scheduled Task 'OpenClaw Custom Gateway' is registered but DISABLED");
    expect(errors).toContain("openclaw gateway start");
    expect(errors).toContain("openclaw doctor --fix");
    expect(errors).toContain("to re-enable it");
    expect(errors).toContain('schtasks /Query /TN "OpenClaw Custom Gateway"');
    expect(errors).not.toContain("likely exited immediately");
  });

  it("prints GUI-session recovery guidance for the service profile", () => {
    printDaemonStatus({
      service: {
        label: "LaunchAgent",
        loadState: { status: "not-loaded" },
        loadedText: "loaded",
        notLoadedText: "not loaded",
        runtime: {
          status: "unknown",
          missingGuiSession: true,
          detail: "Bootstrap failed: 125: Domain does not support specified action",
        },
        command: { programArguments: [], environment: { OPENCLAW_PROFILE: "work" } },
      },
    });

    expectMockLineContains(runtime.error, "macOS has no usable GUI session");
    expectMockLineContains(runtime.error, "logged-in macOS GUI session");
    expectMockLineContains(runtime.error, "openclaw --profile work gateway restart");
  });

  it("prints connectivity and capability without a service config summary", () => {
    printDaemonStatus({
      service: runningService,
      config: { cli: { path: "/tmp/openclaw.json", exists: true, valid: true } },
      gateway,
      rpc: { ok: true, kind: "connect", capability: "write_capable", url: gateway.probeUrl },
    });
    expectMockLineContains(runtime.log, "Connectivity probe: ok");
    expect(
      runtime.log.mock.calls.map(([line]) => line).filter((line) => line.startsWith("Capability:")),
    ).toEqual(["Capability: write-capable"]);
    expect(output(runtime.error)).not.toContain("doctor --fix");
  });

  it("passes daemon TLS state to dashboard link rendering", () => {
    printDaemonStatus({
      service: runningService,
      config: {
        cli: {
          path: "/tmp/openclaw-cli/openclaw.json",
          exists: true,
          valid: true,
        },
        daemon: {
          path: "/tmp/openclaw-daemon/openclaw.json",
          exists: true,
          valid: true,
          controlUi: { basePath: "/ui" },
        },
        mismatch: true,
      },
      gateway: {
        bindMode: "lan",
        bindHost: "0.0.0.0",
        port: 19001,
        portSource: "service args",
        probeUrl: "wss://127.0.0.1:19001",
        tlsEnabled: true,
      },
      rpc: {
        ok: true,
        kind: "connect",
        capability: "write_capable",
        url: "wss://127.0.0.1:19001",
      },
    });

    expect(resolveControlUiLinksMock).toHaveBeenCalledWith({
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
    renderGatewayServiceCleanupHintsMock.mockReturnValue([
      "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    ]);

    printDaemonStatus({
      service: runningService,
      extraServices: [extraService],
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expectMockLineContains(runtime.log, "Other gateway-like services detected");
    expect(renderGatewayServiceCleanupHintsMock).toHaveBeenCalledWith([extraService]);
    expectMockLineContains(
      runtime.log,
      "Cleanup hint: launchctl bootout gui/$UID/com.example.openclaw-gateway",
    );
    expect(output()).not.toContain("ai.openclaw.gateway");
  });

  registerServiceInspectionHintTests({
    renderHints: renderGatewayServiceCleanupHintsMock,
    output,
  });

  it("does not print systemd user-service hints when a gateway responds", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    isSystemdUnavailableDetailMock.mockReturnValue(true);
    renderSystemdUnavailableHintsMock.mockReturnValue(["run loginctl enable-linger"]);

    try {
      printDaemonStatus({
        service: {
          label: "systemd user",
          loadState: { status: "not-loaded" },
          loadedText: "not loaded",
          notLoadedText: "not loaded",
          runtime: { status: "unknown", detail: "systemd user services unavailable" },
        },
        rpc: {
          ok: true,
          url: "ws://127.0.0.1:18789",
          server: { version: "2026.5.12" },
        },
        port: emptyPort("busy"),
      });
    } finally {
      platform.mockRestore();
    }

    const errors = output(runtime.error);
    expect(errors).not.toContain("systemd user services unavailable");
    expect(errors).not.toContain("run loginctl enable-linger");
  });

  it.each([
    { lastExitStatus: undefined, exhausted: true },
    { lastExitStatus: 78, exhausted: false },
  ])(
    "distinguishes systemd crash exhaustion from config exit $lastExitStatus",
    ({ lastExitStatus, exhausted }) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      try {
        printDaemonStatus({
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
      } finally {
        platform.mockRestore();
      }
      const errors = output(runtime.error);
      expect(errors.includes("systemd stopped restarting the gateway after repeated crashes")).toBe(
        exhausted,
      );
      expect(
        errors.includes("Service is loaded but not running (likely exited immediately)."),
      ).toBe(!exhausted);
    },
  );

  it("does not rule out warm-up from port ownership without readiness proof", () => {
    printDaemonStatus({
      service: runningService,
      gateway,
      rpc: {
        ok: false,
        error: "gateway rejected websocket upgrade (HTTP 503)",
        url: "ws://127.0.0.1:18789",
      },
      health: {
        healthy: true,
        staleGatewayPids: [],
      },
    });

    const logged = output();
    expect(logged).not.toMatch(/not a warm-up delay|restart the gateway/i);
    expect(logged).toMatch(/readiness.*not.*confirmed|warm-up.*possible/i);
  });

  it.each([
    {
      serviceRuntime: { status: "running", pid: 8000 },
      runtimeLabel: "running",
      runtimeText: "running (pid 8000)",
      targetRole: "diagnostic-only",
      suffix: " (diagnostic only, not the probe target)",
      rpcOk: false,
    },
    {
      serviceRuntime: undefined,
      runtimeLabel: "absent",
      runtimeText: undefined,
      targetRole: "target",
      suffix: "",
      rpcOk: true,
    },
  ] as const)(
    "projects $targetRole service state with $runtimeLabel runtime",
    ({ serviceRuntime, runtimeText, targetRole, suffix, rpcOk }) => {
      const status: DaemonStatus = {
        extraServices: [],
        service: {
          ...service,
          targetRole,
          runtime: serviceRuntime,
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18900,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18900",
        },
        port: { port: 18900, status: "free", listeners: [], hints: [] },
        rpc: {
          ok: rpcOk,
          error: rpcOk ? undefined : "connect ECONNREFUSED 127.0.0.1:18900",
          url: "ws://127.0.0.1:18900",
        },
      };
      const expectedJson = structuredClone(status);
      printDaemonStatusRuntime(status, { json: false });

      const lines = runtime.log.mock.calls.map(([line]) => line);
      expect(
        lines.filter((line) => line.startsWith("Service:") || line.startsWith("Runtime:")),
      ).toEqual([
        `Service: LaunchAgent (loaded)${suffix}`,
        ...(runtimeText === undefined ? [] : [`Runtime: ${runtimeText}${suffix}`]),
      ]);
      if (targetRole === "diagnostic-only") {
        const combinedOutput = [...lines, output(runtime.error)].join("\n");
        expect(combinedOutput).not.toContain("Warm-up: launch agents");
        expect(combinedOutput).not.toContain("service appears running");
      }
      runtime.log.mockClear();
      runtime.error.mockClear();
      printDaemonStatusRuntime(status, { json: true });
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(expectedJson);
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it("keeps the warm-up hint (not owns-port guidance) when healthy is reachability-only and a stale gateway PID is still held", () => {
    // inspectGatewayRestart can set healthy from reachability after ownership failed,
    // while still returning non-empty staleGatewayPids. That must not be treated as
    // owns-port proof, or this message would contradict the stale-PID diagnostic below.
    printDaemonStatus({
      service: runningService,
      gateway,
      rpc: {
        ok: false,
        error: "gateway closed (1008 policy violation: invalid token)",
        url: "ws://127.0.0.1:18789",
      },
      health: {
        healthy: true,
        staleGatewayPids: [9000],
      },
    });

    const logged = output();
    expect(logged).toContain("Warm-up: launch agents can take a few seconds");
    expect(logged).not.toContain("Gateway process is running and owns the gateway port");
    const errors = output(runtime.error);
    expect(errors).toContain("Gateway runtime PID does not own the listening port");
  });

  function printDrift(entry: NonNullable<DaemonStatus["pluginVersionDrift"]>["drifts"][number]) {
    printDaemonStatus(
      {
        service: runningService,
        pluginVersionDrift: { gatewayVersion: entry.gatewayVersion, drifts: [entry] },
      },
      { json: false, deep: true },
    );
  }

  it("prints the confirmed ClawHub target instead of the host version in deep mode", () => {
    printDrift({
      pluginId: "whatsapp",
      installedVersion: "2026.9.2",
      gatewayVersion: "2026.9.4",
      source: "clawhub",
      targetResolution: {
        status: "resolved",
        packageName: "@openclaw/whatsapp",
        requestedTarget: "latest",
        version: "2026.9.3",
      },
    });

    expectMockLineContains(runtime.log, "- whatsapp: 2026.9.2 (clawhub)");
    expectMockLineContains(
      runtime.log,
      "expected 2026.9.3; clawhub target @openclaw/whatsapp@2026.9.3",
    );
    expect(output()).not.toContain("expected 2026.9.4");
    expectMockLineContains(
      runtime.log,
      `Fix: ${formatCliCommand("openclaw plugins update whatsapp")} && ${formatCliCommand("openclaw gateway restart")}.`,
    );
  });

  it("explains a registry-current ClawHub target without a repair command in deep mode", () => {
    printDrift({
      pluginId: "whatsapp",
      installedVersion: "2026.9.3",
      gatewayVersion: "2026.9.4",
      source: "clawhub",
      targetResolution: {
        status: "registry-current",
        packageName: "@openclaw/whatsapp",
        requestedTarget: "2026.9.4",
        version: "2026.9.3",
      },
    });

    expectMockLineContains(runtime.log, "- whatsapp: 2026.9.3 (clawhub) → expected 2026.9.4");
    expectMockLineContains(
      runtime.log,
      "registry version 2026.9.3 is already installed; no release reaches 2026.9.4 yet",
    );
    const logged = output();
    expect(logged).not.toContain("openclaw plugins update");
    expect(output(runtime.error)).not.toContain("Plugin repair target resolution failed");
  });

  it("prints exact package update commands for pinned npm plugin drift in deep mode", () => {
    printDrift({
      pluginId: "brave",
      installedVersion: "2026.6.9",
      gatewayVersion: "2026.6.10-beta.1",
      source: "npm",
      packageName: "@openclaw/brave-plugin",
      spec: "@openclaw/brave-plugin@2026.6.9",
      targetResolution: {
        status: "resolved",
        packageName: "@openclaw/brave-plugin",
        requestedTarget: "2026.6.10-beta.1",
        version: "2026.6.10-beta.1",
      },
    });

    expectMockLineContains(runtime.log, "- brave: 2026.6.9 (npm)");
    expectMockLineContains(
      runtime.log,
      "openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1",
    );
    expectMockLineContains(runtime.log, "openclaw gateway restart");
  });

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

    expectMockLineContains(runtime.error, "Plugin repair target resolution failed");
    expectMockLineContains(runtime.error, "HTTP 404");
    const combinedOutput = [output(), output(runtime.error)].join("\n");
    expect(combinedOutput).not.toContain("openclaw plugins update");
    expect(combinedOutput).not.toContain("openclaw gateway restart");
  });
  it("reports an admitted probe timeout as event-loop saturation instead of failed connectivity", () => {
    printDaemonStatus(
      {
        service: runningService,
        rpc: {
          ok: false,
          kind: "read",
          gatewayReached: true,
          timedOut: true,
          error: "gateway timeout after 5000ms",
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
        health: { healthy: true, staleGatewayPids: [] },
      },
      { json: false, deep: true },
    );

    const errors = output(runtime.error);
    const logs = output();
    expect(errors).toContain("Read probe: timed out under event-loop load");
    expect(errors).toContain("Gateway event loop: degraded max=5100ms p99=5079ms util=1 cpu=0.94");
    expect(logs).toContain("Gateway accepted the connection");
    expect(errors).not.toContain("Connectivity probe: failed");
    expect(logs).not.toContain("not a warm-up delay");
  });
  it("does not warn about the service install when it matches the CLI version", () => {
    printDaemonStatus({
      cli: { version: "2026.6.35", entrypoint: "/home/ops/.local/bin/openclaw" },
      service: {
        layout: {
          execStart:
            "/usr/bin/node /home/ops/.local/lib/node_modules/openclaw/dist/index.js gateway",
          packageRoot: "/home/ops/.local/lib/node_modules/openclaw",
          packageVersion: "2026.6.35",
        },
      },
    });
    expectMockLineContains(runtime.log, "Gateway service version: 2026.6.35");
    expect(output(runtime.error)).not.toContain("installed Gateway service is version");
  });
});
