import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";

const runTui = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const setupOnboardingShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
  })),
);
const gatewayServiceInstall = vi.hoisted(() => vi.fn(async () => {}));
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const setupRescueWatchdog = vi.hoisted(() =>
  vi.fn(async () => ({
    enabled: true,
    monitoredProfile: "default",
    rescueProfile: "rescue",
    rescuePort: 19789,
    rescueWorkspace: "/tmp-rescue",
    cronAction: "created",
    cronJobId: "job-1",
  })),
);

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(async () => false),
  probeGatewayReachable,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  waitForGatewayReachable: vi.fn(async () => {}),
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("../commands/onboard-rescue.js", () => ({
  canEnableRescueWatchdog: vi.fn(() => true),
  resolveMonitoredProfileName: vi.fn(() => "default"),
  setupRescueWatchdog,
}));

vi.mock("../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ value: "node", label: "Node" }],
}));

vi.mock("../commands/health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("../commands/health.js", () => ({
  healthCommand: vi.fn(async () => {}),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: vi.fn(async () => false),
    restart: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    install: gatewayServiceInstall,
  })),
}));

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    isSystemdUserServiceAvailable,
  };
});

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./onboarding.completion.js", () => ({
  setupOnboardingShellCompletion,
}));

import { finalizeOnboardingWizard } from "./onboarding.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function expectFirstOnboardingInstallPlanCallOmitsToken() {
  const [firstArg] =
    (buildGatewayInstallPlan.mock.calls.at(0) as [Record<string, unknown>] | undefined) ?? [];
  expect(firstArg).toBeDefined();
  expect(firstArg && "token" in firstArg).toBe(false);
}

describe("finalizeOnboardingWizard", () => {
  beforeEach(() => {
    runTui.mockClear();
    probeGatewayReachable.mockClear();
    setupOnboardingShellCompletion.mockClear();
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    setupRescueWatchdog.mockClear();
  });

  it("resolves gateway password SecretRef for probe and TUI", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password"; // pragma: allowlist secret
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your bot?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      select: select as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    try {
      await finalizeOnboardingWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {
          gateway: {
            auth: {
              mode: "password",
              password: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_PASSWORD",
              },
            },
          },
          tools: {
            web: {
              search: {
                apiKey: "",
              },
            },
          },
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "password",
          gatewayToken: undefined,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "resolved-gateway-password", // pragma: allowlist secret
      }),
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "resolved-gateway-password", // pragma: allowlist secret
      }),
    );
  });

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN",
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expectFirstOnboardingInstallPlanCallOmitsToken();
    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  it("sets up rescue watchdog and forces main daemon install when requested", async () => {
    const prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service runtime") {
          return "node";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        rescueWatchdog: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: "session-token",
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
    expect(setupRescueWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        mainPort: 18789,
        workspaceDir: "/tmp",
        runtime: "node",
      }),
    );
  });

  it("skips rescue watchdog when the primary managed service install fails", async () => {
    gatewayServiceInstall.mockRejectedValueOnce(new Error("boom"));
    const note = vi.fn(async () => {});
    const prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service runtime") {
          return "node";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
      note: note as never,
    });

    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        rescueWatchdog: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: "session-token",
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(setupRescueWatchdog).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "Rescue watchdog requires a healthy primary managed service. Gateway service install failed during onboarding, so rescue watchdog was skipped.",
      "Rescue watchdog",
    );
  });

  it("prompts for rescue watchdog when the flag is not explicitly provided", async () => {
    const confirm = vi.fn(async (params: { message: string }) => {
      if (params.message.includes("Enable rescue watchdog")) {
        return false;
      }
      if (params.message === "Install Gateway service (recommended)") {
        return false;
      }
      return false;
    });
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: confirm as never,
    });

    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Enable rescue watchdog (second isolated gateway that auto-restarts this profile if it goes unhealthy)",
      }),
    );
    expect(setupRescueWatchdog).not.toHaveBeenCalled();
  });

  it("does not prompt for rescue watchdog in quickstart unless explicitly requested", async () => {
    const confirm = vi.fn(async () => false);
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: confirm as never,
    });

    await finalizeOnboardingWizard({
      flow: "quickstart",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Enable rescue watchdog (second isolated gateway that auto-restarts this profile if it goes unhealthy)",
      }),
    );
    expect(setupRescueWatchdog).not.toHaveBeenCalled();
  });

  it("throws when setupRescueWatchdog fails and --rescue-watchdog was explicitly requested", async () => {
    setupRescueWatchdog.mockRejectedValueOnce(new Error("ownership conflict"));
    const prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service runtime") {
          return "node";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
    });

    await expect(
      finalizeOnboardingWizard({
        flow: "advanced",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          rescueWatchdog: true,
          skipHealth: true,
          skipUi: true,
        },
        baseConfig: {},
        nextConfig: {
          gateway: {
            auth: {
              mode: "token",
              token: "session-token",
            },
          },
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: "session-token",
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime: createRuntime(),
      }),
    ).rejects.toThrow("ownership conflict");
  });

  it("shows note but continues when setupRescueWatchdog fails and rescue was prompt-confirmed", async () => {
    setupRescueWatchdog.mockRejectedValueOnce(new Error("service install failed"));
    const note = vi.fn(async () => {});
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async (params: { message: string }) => {
        if (params.message.includes("Enable rescue watchdog")) {
          return true;
        }
        if (params.message === "Install Gateway service (recommended)") {
          return true;
        }
        return false;
      }) as never,
      note: note as never,
    });

    // Should NOT throw; rescue was not explicitly flagged via --rescue-watchdog
    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: "session-token",
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(note).toHaveBeenCalledWith("service install failed", "Rescue watchdog");
  });
});
