// Doctor delegates post-restart diagnostics to the health command readiness owner.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const service = vi.hoisted(() => ({
  isLoaded: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stage: vi.fn(),
  install: vi.fn(),
  readCommand: vi.fn(),
}));
const note = vi.hoisted(() => vi.fn());
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const inspectPortConnections = vi.hoisted(() => vi.fn());
const inspectPortUsage = vi.hoisted(() => vi.fn());
const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["Port 18789 is already in use."]));
const isExpectedGatewayListeners = vi.hoisted(() => vi.fn(() => false));
const readLastGatewayErrorLine = vi.hoisted(() => vi.fn(async () => null));
const readGatewayRestartHandoffSync = vi.hoisted(() => vi.fn(() => null));
const findSystemGatewayServices = vi.hoisted(() => vi.fn(async () => []));
const buildGatewayRuntimeHints = vi.hoisted(() => vi.fn((): string[] => []));
const formatGatewayRuntimeSummary = vi.hoisted(() => vi.fn((): string | null => null));
const renderSystemdUnavailableHints = vi.hoisted(() => vi.fn((): string[] => []));
const isDefaultInstallIdentity = vi.hoisted(() => vi.fn(() => true));
const isContainerEnvironment = vi.hoisted(() => vi.fn(() => false));
const findInstalledSystemdGatewayScope = vi.hoisted(() => vi.fn(async () => null));
const resolveGatewayBindHost = vi.hoisted(() => vi.fn(async () => "127.0.0.1"));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, resolveGatewayPort: vi.fn(() => 18789) };
});
vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity };
});
vi.mock("../daemon/constants.js", () => ({
  resolveGatewayLaunchAgentLabel: vi.fn(() => "ai.openclaw.gateway"),
  resolveNodeLaunchAgentLabel: vi.fn(() => "ai.openclaw.node"),
}));
vi.mock("../daemon/diagnostics.js", () => ({ readLastGatewayErrorLine }));
vi.mock("../daemon/launchd.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/launchd.js")>("../daemon/launchd.js");
  return {
    ...actual,
    isLaunchAgentLoaded: vi.fn(async () => false),
    launchAgentPlistExists: vi.fn(async () => false),
    repairLaunchAgentBootstrap: vi.fn(async () => ({ ok: true, status: "repaired" })),
  };
});
vi.mock("../daemon/inspect.js", () => ({ findSystemGatewayServices }));
vi.mock("../daemon/service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
  return { ...actual, resolveGatewayService: () => service };
});
vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  findInstalledSystemdGatewayScope,
}));
vi.mock("../daemon/systemd-hints.js", () => ({ renderSystemdUnavailableHints }));
vi.mock("../gateway/net.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/net.js")>()),
  resolveGatewayBindHost,
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    bindHost === "100.64.0.40" ? [bindHost, "127.0.0.1"] : [bindHost],
}));
vi.mock("../infra/ports-inspect.js", () => ({ inspectPortConnections, inspectPortUsage }));
vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment }));
vi.mock("../infra/ports-format.js", () => ({ formatPortDiagnostics, isExpectedGatewayListeners }));
vi.mock("../infra/restart-handoff.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-handoff.js")>(
    "../infra/restart-handoff.js",
  );
  return { ...actual, readGatewayRestartHandoffSync };
});
vi.mock("../infra/wsl.js", () => ({ isWSL: vi.fn(async () => false) }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: vi.fn(),
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));
vi.mock("./doctor-format.js", () => ({ buildGatewayRuntimeHints, formatGatewayRuntimeSummary }));
vi.mock("./gateway-install-token.js", () => ({ resolveGatewayInstallToken: vi.fn() }));
vi.mock("./health.js", () => ({ healthCommandNonExiting: healthCommand }));

describe("maybeRepairGatewayDaemon restart health", () => {
  let maybeRepairGatewayDaemon: typeof import("./doctor-gateway-daemon-flow.js").maybeRepairGatewayDaemon;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeAll(async () => {
    ({ maybeRepairGatewayDaemon } = await import("./doctor-gateway-daemon-flow.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    healthCommand.mockReset().mockResolvedValue(undefined);
    setPlatform("linux");
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    service.isLoaded.mockResolvedValue(true);
    service.readRuntime.mockResolvedValue({ status: "running" });
    service.readCommand.mockResolvedValue(null);
    service.restart.mockResolvedValue({ outcome: "completed" });
    isDefaultInstallIdentity.mockReturnValue(true);
    isContainerEnvironment.mockReturnValue(false);
    readGatewayRestartHandoffSync.mockReturnValue(null);
    findSystemGatewayServices.mockResolvedValue([]);
    resolveGatewayBindHost.mockResolvedValue("127.0.0.1");
    inspectPortUsage.mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
    inspectPortConnections.mockResolvedValue({ port: 18789, connections: [] });
    isExpectedGatewayListeners.mockReturnValue(false);
    buildGatewayRuntimeHints.mockReturnValue([]);
    formatGatewayRuntimeSummary.mockReturnValue(null);
    renderSystemdUnavailableHints.mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  function setPlatform(platform: NodeJS.Platform) {
    if (!originalPlatformDescriptor) {
      return;
    }
    Object.defineProperty(process, "platform", { ...originalPlatformDescriptor, value: platform });
  }

  async function runAutoRepair() {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime,
      prompter: createDoctorPrompter({ runtime, options: { repair: true } }),
      options: { deep: false, repair: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });
    return runtime;
  }

  it("returns on the first probe when the restarted Gateway is healthy", async () => {
    const startedAt = performance.now();
    const runtime = await runAutoRepair();

    expect(healthCommand).toHaveBeenCalledOnce();
    expect(healthCommand).toHaveBeenCalledWith(
      { json: false, config: { gateway: {} } },
      expect.any(Object),
    );
    expect(performance.now()).toBe(startedAt);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalledWith(expect.stringContaining("still starting"), "Gateway");
  });

  it("fails immediately after restart when the health probe is not a connection refusal", async () => {
    const startedAt = performance.now();
    healthCommand.mockRejectedValueOnce(new Error("unexpected auth failure"));

    const runtime = await runAutoRepair();

    expect(healthCommand).toHaveBeenCalledOnce();
    expect(performance.now()).toBe(startedAt);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("unexpected auth failure"));
  });

  it("does not repeat a reachable Gateway diagnostic already printed by health", async () => {
    healthCommand.mockRejectedValueOnce(new ExitError(1));

    const runtime = await runAutoRepair();

    expect(healthCommand).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
