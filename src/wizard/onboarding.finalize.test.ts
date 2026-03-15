import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const gatewayServiceRestart = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>>(async () => ({
    outcome: "completed",
  })),
);
const gatewayServiceUninstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const loadOpenClawPlugins = vi.hoisted(() =>
  vi.fn(() => ({ searchProviders: [] as unknown[], plugins: [] as unknown[] })),
);
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

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    runTui.mockClear();
    probeGatewayReachable.mockClear();
    setupOnboardingShellCompletion.mockClear();
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset();
    gatewayServiceIsLoaded.mockResolvedValue(false);
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    loadOpenClawPlugins.mockReset();
    loadOpenClawPlugins.mockReturnValue({ searchProviders: [], plugins: [] });
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
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
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

  it("does not report plugin-provided web search providers as missing API keys", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
    });
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
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "tavily",
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const webSearchNote = noteCalls.find((call) => call?.[1] === "Web search");
    expect(webSearchNote?.[0]).toContain("plugin-provided provider");
    expect(webSearchNote?.[0]).toContain("Source: External plugin");
    expect(webSearchNote?.[0]).not.toContain("no API key was found");
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp",
      }),
    );
  });

  it("describes the chosen provider as the active provider when multiple are configured", async () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
    });
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
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "tavily",
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const webSearchNote = noteCalls.find((call) => call?.[1] === "Web search");
    expect(webSearchNote?.[0]).toContain("Active provider: Tavily Search");
    expect(webSearchNote?.[0]).toContain(
      "Multiple web search providers are configured; the others remain available to switch to later via configure.",
    );
  });
});
