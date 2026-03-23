import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

const service = vi.hoisted(() => ({
  isLoaded: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  install: vi.fn(),
  readCommand: vi.fn(),
}));
const note = vi.hoisted(() => vi.fn());
const sleep = vi.hoisted(() => vi.fn(async () => {}));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const inspectPortUsage = vi.hoisted(() => vi.fn());
const readLastGatewayErrorLine = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../config/config.js", () => ({
  resolveGatewayPort: vi.fn(() => 18789),
}));

vi.mock("../daemon/constants.js", () => ({
  resolveGatewayLaunchAgentLabel: vi.fn(() => "ai.openclaw.gateway"),
  resolveNodeLaunchAgentLabel: vi.fn(() => "ai.openclaw.node"),
}));

vi.mock("../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine,
}));

vi.mock("../daemon/launchd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/launchd.js")>();
  return {
    ...actual,
    isLaunchAgentListed: vi.fn(async () => false),
    isLaunchAgentLoaded: vi.fn(async () => false),
    launchAgentPlistExists: vi.fn(async () => false),
    repairLaunchAgentBootstrap: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    resolveGatewayService: () => service,
  };
});

vi.mock("../daemon/systemd-hints.js", () => ({
  renderSystemdUnavailableHints: vi.fn(() => []),
}));

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    isSystemdUserServiceAvailable: vi.fn(async () => true),
  };
});

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage,
  formatPortDiagnostics: vi.fn(() => []),
}));

vi.mock("../infra/wsl.js", () => ({
  isWSL: vi.fn(async () => false),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../utils.js", () => ({
  sleep,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: vi.fn(),
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./doctor-format.js", () => ({
  buildGatewayRuntimeHints: vi.fn(() => []),
  formatGatewayRuntimeSummary: vi.fn(() => null),
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("./health.js", () => ({
  healthCommand,
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
    service.isLoaded.mockResolvedValue(true);
    service.readRuntime.mockResolvedValue({ status: "running" });
    service.restart.mockResolvedValue({ outcome: "completed" });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  function setPlatform(platform: NodeJS.Platform) {
    if (!originalPlatformDescriptor) {
      return;
    }
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: platform,
    });
  }

  function createPrompter(confirmImpl: (message: string) => boolean) {
    return {
      confirm: vi.fn(),
      confirmRepair: vi.fn(),
      confirmAggressive: vi.fn(),
      confirmSkipInNonInteractive: vi.fn(async ({ message }: { message: string }) =>
        confirmImpl(message),
      ),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
    };
  }

  it("skips restart verification when a running service restart is only scheduled", async () => {
    setPlatform("linux");
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter((message) => message === "Restart gateway service now?"),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      "restart scheduled, gateway will restart momentarily",
      "Gateway",
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
  });

  it("skips start verification when a stopped service start is only scheduled", async () => {
    setPlatform("linux");
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    service.restart.mockResolvedValueOnce({ outcome: "scheduled" });

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createPrompter((message) => message === "Start gateway service now?"),
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      "restart scheduled, gateway will restart momentarily",
      "Gateway",
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(healthCommand).not.toHaveBeenCalled();
  });

  it("skips gateway install during non-interactive update repairs", async () => {
    setPlatform("linux");
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    service.isLoaded.mockResolvedValue(false);

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { repair: true, nonInteractive: true },
      }),
      options: { deep: false, repair: true, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("skips gateway restart during non-interactive update repairs", async () => {
    setPlatform("linux");
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { repair: true, nonInteractive: true },
      }),
      options: { deep: false, repair: true, nonInteractive: true },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(service.restart).not.toHaveBeenCalled();
  });
});
