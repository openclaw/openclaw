import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { ExtraGatewayService } from "../daemon/inspect.js";
import * as launchd from "../daemon/launchd.js";
import type { PortUsage } from "../infra/ports-types.js";
import type { GatewayRestartHandoff } from "../infra/restart-handoff.js";
import { ExitError } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import {
  createPrompter,
  mockDoctorRuntimeFacts,
  mockGatewayInstall,
  registerRunningBunFallbackTest,
  setPlatform,
} from "./doctor-gateway-daemon-flow.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  formatServiceRepairDeferredNote,
  SERVICE_REPAIR_POLICY_ENV,
} from "./doctor-service-repair-policy.js";

const makeRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });
const guiDetail = "Bootstrap failed: 125: Domain does not support specified action";
const guiHint =
  "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.";
const systemOwner = "System LaunchDaemon system/ai.openclaw.gateway owns this gateway label.";
const guiRuntime = { status: "unknown", detail: guiDetail, missingGuiSession: true };
const portUsage = (overrides: Partial<PortUsage> = {}): PortUsage => ({
  port: 18789,
  status: "free",
  listeners: [],
  hints: [],
  ...overrides,
});

const readPin = vi.hoisted(() => vi.fn());
// mock-isolation: Service-planning fixtures replace pin admission without opening stores or native locks.
vi.mock("../daemon/runtime-pin-state.js", () => ({
  readDaemonRuntimePinForInstall: readPin,
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, read: () => T) => read(),
}));
const runExec = vi.hoisted(() => vi.fn<typeof import("../process/exec.js").runExec>());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec,
}));

const service = vi.hoisted(() => ({
  unsupportedReason: undefined as string | undefined,
  isLoaded: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  readCommand: vi.fn(),
}));
const note = vi.hoisted(() => vi.fn());
const sleep = vi.hoisted(() => vi.fn(async () => {}));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const formatGatewayClosedDiagnostic = vi.hoisted(() => vi.fn((): string | undefined => undefined));
const formatHealthCheckFailure = vi.hoisted(() => vi.fn((_error: unknown) => "health failed"));
const inspectPortConnections = vi.hoisted(() => vi.fn());
const inspectPortUsage = vi.hoisted(() => vi.fn());
const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["Port 18789 is already in use."]));
const isExpectedGatewayListeners = vi.hoisted(() => vi.fn(() => false));
const readLastGatewayErrorLine = vi.hoisted(() => vi.fn(async () => null));
const readGatewayRestartHandoffSync = vi.hoisted(() =>
  vi.fn<() => GatewayRestartHandoff | null>(() => null),
);
const findSystemGatewayServices = vi.hoisted(() =>
  vi.fn<() => Promise<ExtraGatewayService[]>>(async () => []),
);
const buildGatewayRuntimeHints = vi.hoisted(() => vi.fn((): string[] => []));
const formatRuntimeStatus = vi.hoisted(() => vi.fn((): string | null => null));
const renderSystemdUnavailableHints = vi.hoisted(() => vi.fn((): string[] => []));
const isDefaultInstallIdentity = vi.hoisted(() => vi.fn(() => true));
const isContainerEnvironment = vi.hoisted(() => vi.fn(() => false));
const findInstalledSystemdGatewayScope = vi.hoisted(() =>
  vi.fn<(typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]>(
    async () => null,
  ),
);
const resolveGatewayBindHost = vi.hoisted(() => vi.fn(async () => "127.0.0.1"));

vi.mock("../config/config.js", async (original) => ({
  ...(await original<typeof import("../config/config.js")>()),
  resolveGatewayPort: vi.fn(() => 18789),
}));
vi.mock("../config/paths.js", async (original) => ({
  ...(await original<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity,
}));

vi.mock("../daemon/constants.js", () => ({
  resolveGatewayLaunchAgentLabel: vi.fn(() => "ai.openclaw.gateway"),
  resolveNodeLaunchAgentLabel: vi.fn(() => "ai.openclaw.node"),
}));

// mock-isolation: Error-log diagnostics come from the fixture, not the host service.
vi.mock("../daemon/diagnostics.js", () => ({ readLastGatewayErrorLine }));

vi.mock("../daemon/launchd.js", async (original) => ({
  ...(await original<typeof import("../daemon/launchd.js")>()),
  isLaunchAgentLoaded: vi.fn(async () => false),
  launchAgentPlistExists: vi.fn(async () => false),
  repairLaunchAgentBootstrap: vi.fn(async () => ({ ok: true, status: "repaired" })),
}));

// mock-isolation: Service discovery must not inspect the host's installed daemons.
vi.mock("../daemon/inspect.js", () => ({ findSystemGatewayServices }));

vi.mock("../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));

vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  findInstalledSystemdGatewayScope,
}));

// mock-isolation: Systemd availability is supplied by the platform fixture.
vi.mock("../daemon/systemd-hints.js", () => ({ renderSystemdUnavailableHints }));

vi.mock("../gateway/net.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/net.js")>()),
  resolveGatewayBindHost,
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    bindHost === "100.64.0.40" ? [bindHost, "127.0.0.1"] : [bindHost],
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortConnections,
  inspectPortUsage,
}));

vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment }));

vi.mock("../infra/ports-format.js", () => ({
  formatPortDiagnostics,
  isExpectedGatewayListeners,
}));

vi.mock("../infra/restart-handoff.js", async (original) => ({
  ...(await original<typeof import("../infra/restart-handoff.js")>()),
  readGatewayRestartHandoffSync,
}));

vi.mock("../infra/wsl.js", () => ({
  isWSL: vi.fn(async () => false),
}));

// mock-isolation: Capture Doctor notices without rendering terminal UI.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("../utils.js", async (original) => ({
  ...(await original<typeof import("../utils.js")>()),
  sleep,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: vi.fn(),
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../daemon/runtime-format.js", () => ({ formatRuntimeStatus }));
vi.mock("./doctor-format.js", () => ({ buildGatewayRuntimeHints }));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken: vi.fn(),
}));

// mock-isolation: Each fixture controls its closed-connection diagnostic and health text.
vi.mock("./health-format.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./health-format.js")>()),
  formatGatewayClosedDiagnostic,
  formatHealthCheckFailure,
}));

vi.mock("./health.js", () => ({
  healthCommandNonExiting: healthCommand,
}));

describe("maybeRepairGatewayDaemon", () => {
  let maybeRepairGatewayDaemon: typeof import("./doctor-gateway-daemon-flow.js").maybeRepairGatewayDaemon;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

  beforeAll(async () => {
    ({ maybeRepairGatewayDaemon } = await import("./doctor-gateway-daemon-flow.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    mockDoctorRuntimeFacts(runExec);
    readPin.mockReset().mockReturnValue({ revision: "empty", stored: false });
    formatGatewayClosedDiagnostic.mockReset().mockReturnValue(undefined);
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    service.unsupportedReason = undefined;
    service.isLoaded.mockResolvedValue(true);
    service.readRuntime.mockResolvedValue({ status: "running" });
    service.readCommand.mockResolvedValue(null);
    service.restart.mockResolvedValue({ outcome: "completed" });
    isDefaultInstallIdentity.mockReturnValue(true);
    isContainerEnvironment.mockReturnValue(false);
    readGatewayRestartHandoffSync.mockReturnValue(null);
    findSystemGatewayServices.mockResolvedValue([]);
    resolveGatewayBindHost.mockResolvedValue("127.0.0.1");
    inspectPortUsage.mockResolvedValue(portUsage());
    inspectPortConnections.mockResolvedValue({
      port: 18789,
      connections: [],
    });
    isExpectedGatewayListeners.mockReturnValue(false);
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValue(false);
    vi.mocked(launchd.repairLaunchAgentBootstrap).mockResolvedValue({
      ok: true,
      status: "repaired",
    });
    buildGatewayRuntimeHints.mockReturnValue([]);
    formatRuntimeStatus.mockReturnValue(null);
    renderSystemdUnavailableHints.mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  type DoctorParameters = Parameters<typeof maybeRepairGatewayDaemon>[0];

  function runDoctor(params: Partial<DoctorParameters> = {}) {
    return maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: makeRuntime(),
      prompter: createPrompter(() => true),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
      ...params,
    });
  }

  async function runNonInteractiveRepair(params: Partial<DoctorParameters> = {}) {
    return runAutoRepair({ repair: true, nonInteractive: true }, params);
  }

  async function runAutoRepair(
    options: DoctorParameters["options"] = { repair: true },
    params: Partial<DoctorParameters> = {},
  ) {
    const runtime = makeRuntime();
    await runDoctor({
      runtime,
      prompter: createDoctorPrompter({ runtime, options }),
      options: { deep: false, ...options },
      ...params,
    });
    return runtime;
  }

  function expectNote(message: unknown, title = "Gateway") {
    expect(note).toHaveBeenCalledWith(message, title);
  }

  function expectNoServiceCalls(
    methods = [
      service.isLoaded,
      service.readRuntime,
      service.readCommand,
      service.install,
      service.restart,
      findSystemGatewayServices,
    ],
  ) {
    for (const method of methods) {
      expect(method).not.toHaveBeenCalled();
    }
  }

  function recentHandoff(overrides: Partial<GatewayRestartHandoff>): GatewayRestartHandoff {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    return {
      kind: "gateway-supervisor-restart-handoff",
      version: 1,
      intentId: "intent-healthy",
      pid: 99_999,
      createdAt: 35_000,
      expiresAt: 95_000,
      reason: "update.run",
      source: "gateway-update",
      restartKind: "update-process",
      supervisorMode: "systemd",
      ...overrides,
    };
  }

  function parkedLaunchAgent() {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValue(false);
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValue(false);
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValueOnce(true).mockResolvedValue(false);
  }

  it.each(["running", "stopped"])(
    "skips verification when %s service restart is scheduled",
    async (status) => {
      service.readRuntime.mockResolvedValue({ status });
      service.restart.mockResolvedValueOnce({ outcome: "scheduled" });
      await runDoctor({
        prompter: createPrompter(
          (message) =>
            message === `${status === "running" ? "Restart" : "Start"} gateway service now?`,
        ),
      });

      expect(service.restart).toHaveBeenCalledTimes(1);
      expectNote("restart scheduled, gateway will restart momentarily");
      expect(sleep).not.toHaveBeenCalled();
      expect(healthCommand).not.toHaveBeenCalled();
    },
  );

  it("skips every service-manager seam for a non-default install identity", async () => {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-copied-state",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-copied-state/openclaw.json",
      },
      async () => {
        isDefaultInstallIdentity.mockReturnValue(false);
        await runNonInteractiveRepair();
      },
    );

    expectNoServiceCalls();
    expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expectNote("service management skipped: non-default state dir or config path");
  });

  it.each([
    { environment: "container without an OpenClaw service", detected: true },
    { environment: "Kubernetes pod without container markers", kubernetes: true },
  ])(
    "keeps port diagnostics but never probes host services in a $environment",
    async (scenario) => {
      isContainerEnvironment.mockReturnValue(scenario.detected === true);
      inspectPortUsage.mockResolvedValueOnce(
        portUsage({
          status: "busy",
          listeners: [{ pid: 1234, command: "other-process" }],
        }),
      );

      await withEnvAsync(
        {
          KUBERNETES_SERVICE_HOST: scenario.kubernetes ? "10.96.0.1" : undefined,
          KUBERNETES_SERVICE_PORT: scenario.kubernetes ? "443" : undefined,
          OPENCLAW_SUPERVISOR_MODE: undefined,
        },
        runNonInteractiveRepair,
      );

      expect(inspectPortUsage).toHaveBeenCalledOnce();
      expect(note).toHaveBeenCalledWith("Port 18789 is already in use.", "Gateway port");
      expect(note).toHaveBeenCalledWith(formatServiceRepairDeferredNote("external"), "Gateway");
      expect(findInstalledSystemdGatewayScope).toHaveBeenCalledTimes(scenario.detected ? 1 : 0);
      expectNoServiceCalls();
    },
  );

  it("recovers an installed local service through a reachable Docker systemd manager", async () => {
    isContainerEnvironment.mockReturnValue(true);
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "user",
      unitName: "openclaw-gateway.service",
      unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
    });
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    const prompter = createPrompter(() => true);

    await runDoctor({
      cfg: { gateway: { mode: "local" } },
      prompter,
      options: {},
      healthSkipped: false,
    });

    expect(service.isLoaded).toHaveBeenCalledWith({ env: process.env, timeoutMs: 5_000 });
    expect(service.readRuntime).toHaveBeenCalledOnce();
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Start gateway service now?" }),
    );
    expect(service.restart).toHaveBeenCalledOnce();
    expect(note).not.toHaveBeenCalledWith(formatServiceRepairDeferredNote("external"), "Gateway");
  });

  it("reports recent restart handoffs during deep doctor", async () => {
    service.readCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway"],
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-service",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-service/openclaw.json",
      },
    });
    readGatewayRestartHandoffSync.mockReturnValueOnce(
      recentHandoff({
        pid: 12_345,
        createdAt: 10_000,
        expiresAt: 70_000,
        reason: "plugin source changed",
        source: "plugin-change",
        restartKind: "full-process",
      }),
    );

    await runAutoRepair({ deep: true, nonInteractive: true });

    expect(readGatewayRestartHandoffSync).toHaveBeenCalledTimes(2);
    const [handoffEnv] = readGatewayRestartHandoffSync.mock.calls[0] as unknown as [
      { OPENCLAW_STATE_DIR?: string; OPENCLAW_CONFIG_PATH?: string },
    ];
    expect(handoffEnv?.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-service");
    expect(handoffEnv?.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-service/openclaw.json");
    expectNote(
      "Recent restart handoff: full-process via systemd; source=plugin-change; reason=plugin source changed; pid=12345; age=30s; expiresIn=30s",
    );
  });

  it("still audits missing service when gateway health was skipped", async () => {
    service.isLoaded.mockResolvedValueOnce(false);
    await runAutoRepair({ nonInteractive: true }, { healthSkipped: true });

    expect(note).toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
  });

  it.each([undefined, "External service manager owns this Gateway."])(
    "reports unknown inspection without repair (%s)",
    async (unsupportedReason) => {
      setPlatform(unsupportedReason ? "freebsd" : "linux");
      service.unsupportedReason = unsupportedReason;
      service.isLoaded.mockRejectedValueOnce(
        new Error("systemctl is-enabled unavailable: Failed to connect to bus: No medium found"),
      );
      renderSystemdUnavailableHints.mockReturnValueOnce(["restore the systemd user bus"]);
      const prompter = createPrompter(() => true);

      await runDoctor({ prompter });

      if (unsupportedReason) {
        expect(note).toHaveBeenCalledTimes(1);
        expect(note).toHaveBeenCalledWith(unsupportedReason, "Gateway");
      } else {
        expect(renderSystemdUnavailableHints).toHaveBeenCalledWith({
          wsl: false,
          kind: "user_bus_unavailable",
        });
        expect(note).toHaveBeenCalledWith(
          expect.stringContaining("Gateway service status could not be determined"),
          "Gateway",
        );
        expect(note).toHaveBeenCalledWith(
          expect.stringContaining("restore the systemd user bus"),
          "Gateway",
        );
      }
      expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(findSystemGatewayServices).not.toHaveBeenCalled();
    },
  );

  it("preserves a real remote health failure through the ordered recovery contributions", async () => {
    const {
      createDoctorHealthFlowContext,
      resolveDoctorHealthContributions,
      runDoctorHealthContributionList,
    } = await import("../flows/doctor-health-contributions.test-support.js");
    const prompter = createPrompter(() => true);
    const ctx = createDoctorHealthFlowContext({
      cfg: { gateway: { mode: "remote" } },
      prompter,
    });
    const contributions = resolveDoctorHealthContributions().filter(
      ({ id }) => id === "doctor:gateway-health" || id === "doctor:gateway-daemon",
    );
    expect(contributions.map(({ id }) => id)).toEqual([
      "doctor:gateway-health",
      "doctor:gateway-daemon",
    ]);

    // The real Gateway call rejects a missing remote URL before opening a socket.
    await runDoctorHealthContributionList(ctx, contributions);

    expect(ctx).toMatchObject({ healthOk: false, gatewayHealthSkipped: false });
    expect(ctx.runtime.error).toHaveBeenCalledOnce();
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("does not start loaded services with unknown runtime when health was skipped", async () => {
    service.readRuntime.mockResolvedValueOnce({ status: "unknown" });

    await runNonInteractiveRepair({ healthSkipped: true });

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("reports established gateway clients during healthy deep doctor", async () => {
    inspectPortConnections.mockResolvedValueOnce({
      port: 18789,
      connections: [
        {
          pid: 5151,
          command: "node",
          commandLine: "/tmp/newer-openclaw/bin/openclaw logs --follow",
          address: "TCP 127.0.0.1:50123->127.0.0.1:18789 (ESTABLISHED)",
          direction: "client",
        },
      ],
    });

    await runAutoRepair({ deep: true, nonInteractive: true }, { healthOk: true });

    expect(inspectPortUsage).not.toHaveBeenCalled();
    const gatewayClientNote = note.mock.calls.find(([, label]) => label === "Gateway clients");
    expect(gatewayClientNote?.[0]).toContain("pid=5151");
    expect(gatewayClientNote?.[0]).toContain("protocol mismatch after rollback");
  });

  it("suppresses busy-port note for expected Gateway listeners", async () => {
    const listeners = [{ pid: 5001, commandLine: "openclaw-gateway", address: "0.0.0.0:18789" }];
    inspectPortUsage.mockResolvedValue(portUsage({ status: "busy", listeners }));
    isExpectedGatewayListeners.mockReturnValue(true);

    await runNonInteractiveRepair();

    expect(resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
    expect(inspectPortUsage).toHaveBeenCalledWith(18789, {
      probeHosts: ["127.0.0.1"],
    });
    expect(isExpectedGatewayListeners).toHaveBeenCalledWith(listeners, 18789);
    expect(formatPortDiagnostics).not.toHaveBeenCalled();
    expect(note.mock.calls.some(([, label]) => label === "Gateway port")).toBe(false);
  });

  it.each([
    { recorded: "bun", pinned: false, supported: true, choice: "fallback" },
    { recorded: "bun", pinned: false, supported: false, choice: "node" },
    { recorded: "node", pinned: true, supported: true, choice: "node" },
  ])(
    "reinstalls recorded $recorded with choice=$choice (pinned=$pinned, supported=$supported)",
    async ({ recorded, pinned, supported, choice }) => {
      const recordedPath = `/opt/recorded/bin/${recorded}`;
      if (!supported) {
        const probeRuntime = runExec.getMockImplementation()!;
        runExec.mockImplementation((executable, ...args) => {
          if (executable === recordedPath) {
            return Promise.reject(new Error("missing runtime"));
          }
          return probeRuntime(executable, ...args);
        });
      }
      const pin = pinned ? { runtime: "bun", path: "/opt/pinned/bun" } : undefined;
      const expected = { revision: "pin-version", stored: pinned, pin };
      readPin.mockReturnValue(expected);
      const managedDefinition = {
        programArguments: [recordedPath, "/opt/openclaw/dist/index.js", "gateway"],
        environment: { NODE_OPTIONS: "", UNRELATED: "not-persisted" },
      };
      const existingCommand = {
        ...managedDefinition,
        environment: { NODE_OPTIONS: "--max-old-space-size=512" },
        managedDefinition,
        managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
      };
      service.readCommand.mockResolvedValue(existingCommand);
      mockGatewayInstall(service, managedDefinition.programArguments, { NODE_OPTIONS: "" });
      const prompter = createPrompter(() => true);
      if (choice === "fallback") {
        // Keep install consent in the fixture; exercise Doctor's real --fix runtime fallback.
        const nonInteractive = createDoctorPrompter({
          runtime: makeRuntime(),
          options: { repair: true, nonInteractive: true },
        });
        prompter.select.mockImplementation(nonInteractive.select);
      } else {
        prompter.select.mockResolvedValue(choice);
      }

      await runDoctor({ prompter });

      expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({ existingCommand }),
      );
      expect(vi.mocked(buildGatewayInstallPlan).mock.calls[0]?.[0]).not.toHaveProperty(
        "existingEnvironment",
      );
      expect(service.install).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePinUpdate: { expected, pin },
        }),
      );
      const plan = vi.mocked(buildGatewayInstallPlan).mock.calls[0]?.[0];
      const selectedRuntime = pin?.runtime ?? (choice === "fallback" ? recorded : choice);
      expect(plan).toMatchObject({
        runtime: selectedRuntime,
        pinnedRuntimePath: pin?.path,
        runtimePath:
          !pinned && supported && selectedRuntime === recorded ? recordedPath : undefined,
      });
      if (pinned) {
        expect(prompter.select).not.toHaveBeenCalled();
      } else {
        const defaultRuntime = supported ? recorded : "node";
        expect(prompter.select).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ initialValue: defaultRuntime }),
          defaultRuntime,
        );
      }
    },
  );

  registerRunningBunFallbackTest({ runDoctor, service });

  it("skips gateway install during non-interactive doctor repairs", async () => {
    service.isLoaded.mockResolvedValue(false);

    await runNonInteractiveRepair();

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expectNote(
      `Run ${formatCliCommand("openclaw gateway install")} when you want to install the gateway service.`,
    );
  });

  it.each([false, true])(
    "does not restart a running service non-interactively (update=%s)",
    async (updating) => {
      if (updating) {
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
      }
      await runNonInteractiveRepair();
      if (!updating) {
        expect(service.isLoaded).toHaveBeenCalledOnce();
        expect(service.readRuntime).toHaveBeenCalledOnce();
      }
      expect(service.restart).not.toHaveBeenCalled();
    },
  );

  it("restarts with explicit --yes", async () => {
    await runAutoRepair({ yes: true });

    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("reports a typed close after restart and masks the connection note", async () => {
    const error = new Error("transport closed after restart");
    healthCommand.mockRejectedValueOnce(error);
    formatGatewayClosedDiagnostic.mockReturnValueOnce(
      "Gateway connect failed: transport closed after restart",
    );

    const runtime = await runAutoRepair(undefined, {
      gatewayDetailsMessage: "details password=doctorSynthetic7",
    });

    expect(formatGatewayClosedDiagnostic).toHaveBeenCalledWith(error);
    expectNote("Gateway connect failed: transport closed after restart");
    expect(note).toHaveBeenCalledWith("details password=***", "Gateway connection");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([
    { action: "install", loaded: false, runtime: "stopped" },
    { action: "start", loaded: true, runtime: "stopped" },
    { action: "restart", loaded: true, runtime: "running" },
  ])("skips service $action under external repair policy", async ({ loaded, runtime }) => {
    service.isLoaded.mockResolvedValue(loaded);
    service.readRuntime.mockResolvedValue({ status: runtime });

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, runAutoRepair);

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(formatServiceRepairDeferredNote("external"), "Gateway");
  });

  it("skips gateway service install when a system OpenClaw gateway service exists", async () => {
    service.isLoaded.mockResolvedValue(false);
    findSystemGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "openclaw-gateway.service",
        detail: "unit: /etc/systemd/system/openclaw-gateway.service",
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
    ]);

    await runAutoRepair();

    expect(findSystemGatewayServices).toHaveBeenCalledTimes(1);
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expectNote(
      [
        "System-level OpenClaw gateway service detected while the user gateway service is not installed.",
        "- openclaw-gateway.service (unit: /etc/systemd/system/openclaw-gateway.service)",
        "OpenClaw will not install a second user-level gateway service automatically.",
        "Run `openclaw gateway status --deep` or `openclaw doctor --deep` to inspect duplicate services.",
        `Set ${SERVICE_REPAIR_POLICY_ENV}=external if a system supervisor owns the gateway lifecycle.`,
      ].join("\n"),
    );
  });

  it("skips LaunchAgent bootstrap repair when service repair policy is external", async () => {
    parkedLaunchAgent();

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, runAutoRepair);

    expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expectNote(formatServiceRepairDeferredNote("external"), "Gateway LaunchAgent");
    expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
    expect(buildGatewayRuntimeHints).not.toHaveBeenCalled();
  });

  it("re-enables and bootstraps a parked LaunchAgent during non-interactive repair", async () => {
    setPlatform("darwin");
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValue(true);
    service.readRuntime
      .mockResolvedValueOnce({ status: "stopped" })
      .mockResolvedValue({ status: "running" });
    vi.mocked(launchd.launchAgentPlistExists).mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.mocked(launchd.isLaunchAgentLoaded).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runNonInteractiveRepair();

    expect(launchd.repairLaunchAgentBootstrap).toHaveBeenCalledWith({
      env: process.env,
    });
    expect(service.install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith("Gateway LaunchAgent repaired.", "Gateway LaunchAgent");
  });

  it.each([false, true])(
    "stops recovery for system ownership (bootstrap=%s)",
    async (bootstrap) => {
      setPlatform("darwin");
      if (bootstrap) {
        parkedLaunchAgent();
        vi.mocked(launchd.repairLaunchAgentBootstrap).mockResolvedValueOnce({
          ok: false,
          status: "system-launchdaemon-conflict",
          detail: systemOwner,
        });
      } else {
        service.readRuntime.mockResolvedValue({
          status: "unknown",
          detail: systemOwner,
          systemLaunchDaemon: { status: "loaded", serviceTarget: "system/ai.openclaw.gateway" },
        });
        formatRuntimeStatus.mockReturnValue(`unknown (${systemOwner})`);
      }
      await runAutoRepair();
      expectNoServiceCalls([service.install, service.restart]);
      expectNote(bootstrap ? systemOwner : `Runtime: unknown (${systemOwner})`);
      if (!bootstrap) {
        expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
      }
    },
  );

  it("reports restart ownership failures instead of aborting doctor", async () => {
    setPlatform("darwin");
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    service.restart.mockRejectedValue(new Error(systemOwner));

    await expect(runAutoRepair()).resolves.toBeDefined();

    expectNote(`Gateway service restart failed: ${systemOwner}`);
  });

  it.each([false, true])(
    "reports GUI-session recovery instead of install guidance (bootstrap=%s)",
    async (bootstrap) => {
      setPlatform("darwin");
      if (bootstrap) {
        parkedLaunchAgent();
        vi.mocked(launchd.repairLaunchAgentBootstrap).mockResolvedValueOnce({
          ok: false,
          status: "gui-session-unavailable",
          detail: guiDetail,
          domain: "gui/501",
        });
      } else {
        service.isLoaded.mockResolvedValue(false);
        service.readRuntime.mockResolvedValue(guiRuntime);
      }
      buildGatewayRuntimeHints.mockReturnValue([guiHint]);

      const runtime = await runAutoRepair();

      expect(runtime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("LaunchAgent bootstrap failed"),
      );
      expect(service.install).not.toHaveBeenCalled();
      expect(buildGatewayRuntimeHints).toHaveBeenCalledWith(guiRuntime, {
        platform: "darwin",
        env: process.env,
      });
      expectNote(guiHint);
      if (!bootstrap) {
        expect(launchd.repairLaunchAgentBootstrap).not.toHaveBeenCalled();
        expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
      }
    },
  );

  it.each([true, false])(
    "preserves a recent restart only when health succeeds (healthy=%s)",
    async (healthy) => {
      readGatewayRestartHandoffSync.mockReturnValue(recentHandoff({}));
      if (!healthy) {
        healthCommand.mockRejectedValueOnce(new Error("gateway closed"));
      }
      await runDoctor({ prompter: createPrompter(() => healthy) });
      expect(readGatewayRestartHandoffSync).toHaveBeenCalled();
      expect(healthCommand).toHaveBeenCalledOnce();
      expect(service.restart).not.toHaveBeenCalled();
      if (healthy) {
        expectNote("Preserving the recent Gateway restart; skipping restart prompt.");
      }
    },
  );

  describe("restart health", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      healthCommand.mockReset().mockResolvedValue(undefined);
    });

    it.each([false, true])(
      "reports a masked unit without trying installation or restart (healthy=%s)",
      async (healthy) => {
        const message =
          "Service is masked. Run systemctl --user unmask openclaw-gateway.service, then retry.";
        service.isLoaded.mockResolvedValue(false);
        service.readRuntime.mockResolvedValue({
          status: healthy ? "running" : "stopped",
          detail: message,
          systemd: { startRefusal: { reason: "masked", message } },
        });
        await runAutoRepair({ repair: true }, { healthOk: healthy });
        expectNote(message);
        expect(note).not.toHaveBeenCalledWith("Gateway service not installed.", "Gateway");
        expectNoServiceCalls([service.install, service.restart]);
      },
    );

    it.each(["healthy", "auth failure", "already printed"])(
      "settles the first restart health probe: %s",
      async (outcome) => {
        if (outcome === "auth failure") {
          const actual =
            await vi.importActual<typeof import("./health-format.js")>("./health-format.js");
          formatHealthCheckFailure.mockImplementationOnce(actual.formatHealthCheckFailure);
          healthCommand.mockRejectedValueOnce(new Error("unexpected auth failure"));
        } else if (outcome === "already printed") {
          healthCommand.mockRejectedValueOnce(new ExitError(1));
        }
        const startedAt = performance.now();
        const runtime = await runAutoRepair();
        expect(healthCommand).toHaveBeenCalledOnce();
        expect(performance.now()).toBe(startedAt);
        expect(vi.getTimerCount()).toBe(0);
        if (outcome === "auth failure") {
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("unexpected auth failure"),
          );
        } else {
          expect(runtime.error).not.toHaveBeenCalled();
        }
        if (outcome === "healthy") {
          expect(healthCommand).toHaveBeenCalledWith(
            { json: false, config: { gateway: {} } },
            expect.any(Object),
          );
          expect(note).not.toHaveBeenCalledWith(
            expect.stringContaining("still starting"),
            "Gateway",
          );
        }
      },
    );
  });
});
