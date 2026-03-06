import { beforeEach, describe, expect, it, vi } from "vitest";

const withProgress = vi.hoisted(() => vi.fn(async (_opts, run) => run({ setLabel: vi.fn() })));
const loadConfig = vi.hoisted(() => vi.fn());
const resolveGatewayInstallToken = vi.hoisted(() => vi.fn());
const buildGatewayInstallPlan = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());
const serviceInstall = vi.hoisted(() => vi.fn(async () => {}));
const ensureSystemdUserLingerInteractive = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../cli/progress.js", () => ({
  withProgress,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("./gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("./configure.shared.js", () => ({
  confirm: vi.fn(async () => true),
  select: vi.fn(async () => "node"),
}));

vi.mock("./daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ value: "node", label: "Node" }],
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: vi.fn(async () => false),
    install: serviceInstall,
  })),
}));

vi.mock("./onboard-helpers.js", () => ({
  guardCancel: (value: unknown) => value,
}));

vi.mock("./systemd-linger.js", () => ({
  ensureSystemdUserLingerInteractive,
}));

const { maybeInstallDaemon } = await import("./configure.daemon.js");

describe("maybeInstallDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({});
    resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      warnings: [],
    });
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {},
    });
  });

  it("does not serialize SecretRef token into service environment", async () => {
    await maybeInstallDaemon({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      port: 18789,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        token: undefined,
      }),
    );
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("blocks install when token SecretRef is unresolved", async () => {
    resolveGatewayInstallToken.mockResolvedValue({
      token: undefined,
      tokenRefConfigured: true,
      unavailableReason: "gateway.auth.token SecretRef is configured but unresolved (boom).",
      warnings: [],
    });

    await maybeInstallDaemon({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      port: 18789,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway install blocked"),
      "Gateway",
    );
    expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
  });
});
