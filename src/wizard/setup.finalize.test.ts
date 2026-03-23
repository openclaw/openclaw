import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  createLocalSetupIntent,
  resolveLocalSetupExecutionPlan,
} from "../commands/onboard-local-plan.js";
import { createLocalOnboardingPlan } from "../commands/onboard-plan.js";
import type { RuntimeEnv } from "../runtime.js";

const runTui = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
  })),
);
const gatewayServiceInstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceRestart = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>>(async () => ({
    outcome: "completed",
  })),
);
const gatewayServiceUninstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));

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

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    resolveGatewayService: vi.fn(() => ({
      isLoaded: gatewayServiceIsLoaded,
      restart: gatewayServiceRestart,
      uninstall: gatewayServiceUninstall,
      install: gatewayServiceInstall,
    })),
  };
});

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

vi.mock("./setup.completion.js", () => ({
  setupWizardShellCompletion,
}));

import { finalizeSetupWizard } from "./setup.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createFinalizePlan(params?: {
  flow?: "advanced" | "quickstart";
  installDaemon?: boolean;
  skipHealth?: boolean;
}) {
  const flow = params?.flow ?? "advanced";
  const intent = createLocalSetupIntent({
    workspaceDir: "/tmp",
    authChoice: "skip",
    installDaemon: params?.installDaemon,
    skipHealth: params?.skipHealth,
  });
  const settings = {
    mode: "local" as const,
    port: 18789,
    bind: "loopback" as const,
    authMode: "token" as const,
    gatewayToken: "session-token",
    tailscaleMode: "off" as const,
    tailscaleResetOnExit: false,
  };

  return {
    intent,
    onboardingPlan: createLocalOnboardingPlan({
      executionMode: "interactive",
      flow,
      intent,
      gatewayState: settings,
      executionPlan: resolveLocalSetupExecutionPlan({
        intent,
        executionMode: "interactive",
        flow,
        platform: "darwin",
      }),
      opts: {
        installDaemon: params?.installDaemon,
        skipHealth: params?.skipHealth,
      },
    }),
    settings,
  };
}

function expectFirstOnboardingInstallPlanCallOmitsToken() {
  const [firstArg] =
    (buildGatewayInstallPlan.mock.calls.at(0) as [Record<string, unknown>] | undefined) ?? [];
  expect(firstArg).toBeDefined();
  expect(firstArg && "token" in firstArg).toBe(false);
}

describe("finalizeSetupWizard", () => {
  beforeEach(() => {
    runTui.mockClear();
    probeGatewayReachable.mockClear();
    setupWizardShellCompletion.mockClear();
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset();
    gatewayServiceIsLoaded.mockResolvedValue(false);
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
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
    const plan = createFinalizePlan({
      flow: "quickstart",
      installDaemon: false,
      skipHealth: true,
    });

    try {
      await finalizeSetupWizard({
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
        intent: plan.intent,
        onboardingPlan: plan.onboardingPlan,
        settings: {
          ...plan.settings,
          authMode: "password",
          gatewayToken: undefined,
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
    const plan = createFinalizePlan({
      flow: "advanced",
      installDaemon: true,
      skipHealth: true,
    });

    await finalizeSetupWizard({
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
      intent: plan.intent,
      onboardingPlan: plan.onboardingPlan,
      settings: plan.settings,
      prompter,
      runtime,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expectFirstOnboardingInstallPlanCallOmitsToken();
    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  it("stops after a scheduled restart instead of reinstalling the service", async () => {
    const progressUpdate = vi.fn();
    const progressStop = vi.fn();
    gatewayServiceIsLoaded.mockResolvedValue(true);
    gatewayServiceRestart.mockResolvedValueOnce({ outcome: "scheduled" });
    const prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service already installed") {
          return "restart";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: progressUpdate, stop: progressStop })),
    });
    const plan = createFinalizePlan({
      flow: "advanced",
      installDaemon: true,
      skipHealth: true,
    });

    await finalizeSetupWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      intent: plan.intent,
      onboardingPlan: plan.onboardingPlan,
      settings: {
        ...plan.settings,
        gatewayToken: undefined,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(gatewayServiceRestart).toHaveBeenCalledTimes(1);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    expect(progressUpdate).toHaveBeenCalledWith("Restarting Gateway service…");
    expect(progressStop).toHaveBeenCalledWith("Gateway service restart scheduled.");
  });

  it("prompts before daemon install for advanced local onboarding defaults", async () => {
    const confirm = vi.fn(async () => false);
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm,
    });
    const plan = createFinalizePlan({
      flow: "advanced",
    });

    await finalizeSetupWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      intent: plan.intent,
      onboardingPlan: plan.onboardingPlan,
      settings: plan.settings,
      prompter,
      runtime: createRuntime(),
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Install Gateway service (recommended)",
        initialValue: true,
      }),
    );
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
      }),
    );
  });
});
