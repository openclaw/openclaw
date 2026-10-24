import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSetupHealthGateway } from "../../test/helpers/setup-health-gateway.js";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type * as AuthChoiceModelCheck from "../commands/auth-choice.model-check.js";

type DefaultModelAuthStatus = Awaited<
  ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>
>;

const readPin = vi.hoisted(() => vi.fn());
// mock-isolation: Service-planning fixtures replace pin admission without opening stores or native locks.
vi.mock("../daemon/runtime-pin-state.js", () => ({
  readDaemonRuntimePinForInstall: readPin,
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, read: () => T): Promise<T> =>
    read(),
}));

const {
  runTui,
  restoreTerminalState,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
  resolveAdvertisedControlUiLinks,
  resolveLocalControlUiProbeLinks,
  setupWizardShellCompletion,
  loadModelCatalog,
  gatewayServiceInstall,
  gatewayServiceRestart,
  gatewayServiceUninstall,
  gatewayServiceIsLoaded,
  gatewayServiceReadCommand,
  startGatewayService,
  resolveGatewayInstallToken,
  isSystemdUserServiceAvailable,
  resolveSystemdUserServiceAccount,
  readSystemdUserLingerStatus,
  resolveSetupSecretInputString,
  resolveExistingKey,
  hasExistingKey,
  hasKeyInEnv,
  listConfiguredWebSearchProviders,
  hasAuthProfileForProvider,
  isContainerEnvironment,
  startOnboardingGatewayProcess,
  describeGatewayServiceRestart,
  resetFinalizeMocks,
} = await vi.hoisted(async () => {
  const { createFinalizeMocks } = await import("./setup.finalize.fixtures.test-support.js");
  return createFinalizeMocks();
});

const healthCommand = vi.hoisted(() =>
  vi.fn<typeof import("../commands/health.js").healthCommandNonExiting>(async () => {}),
);
const resolveDefaultModelAuthStatus = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>
    ) => DefaultModelAuthStatus
  >(() => ({
    provider: "anthropic",
    model: "test-model",
    status: "ready",
    hasAuth: true,
  })),
);
const resolveDefaultModelCatalogFacts = vi.hoisted(() =>
  vi.fn((): ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelCatalogFacts> => ({})),
);
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async (_params?: { warn?: (message: string, title?: string) => void }) => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
    environmentValueSources: {},
  })),
);
const gatewayServiceReadRuntime = vi.hoisted(() => vi.fn());
const inspectWindowsGatewayFirewall = vi.hoisted(() =>
  vi.fn<() => Promise<unknown>>(async () => ({
    applies: false,
    severity: "info",
    code: "windows_firewall_not_applicable",
    message: "Windows LAN firewall diagnostics do not apply.",
    details: [],
  })),
);

vi.mock("../commands/onboard-helpers.js", () => ({
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveLocalControlUiProbeLinks,
  waitForGatewayReachable,
}));

vi.mock("../commands/control-ui-handoff.js", () => ({
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
}));

vi.mock("../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall,
  formatWindowsGatewayFirewallGuidance: (params: { bind?: string }) =>
    params.bind === "lan"
      ? [
          "Windows firewall: if another device cannot connect to the LAN URL, run `openclaw gateway status --deep` from this Windows host.",
        ]
      : [],
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("../commands/health-format.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/health-format.js")>()),
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("../commands/health.js", () => ({
  healthCommandNonExiting: healthCommand,
}));

vi.mock("../flows/search-setup.js", () => ({
  listSearchProviderOptions: () => [],
  resolveSearchProviderOptions: () => [],
  hasExistingKey,
  hasKeyInEnv,
  resolveExistingKey,
}));

vi.mock("../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider,
}));

vi.mock("../web-search/runtime.js", () => ({
  listConfiguredWebSearchProviders,
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  describeGatewayServiceRestart: vi.fn(describeGatewayServiceRestart),
  formatGatewayServiceStartRepairIssues: (issues: Array<{ message: string }>) =>
    issues.map((issue) => issue.message).join("; "),
  startGatewayService,
  resolveGatewayService: vi.fn(() => ({
    label: "Mock Platform Service",
    isLoaded: gatewayServiceIsLoaded,
    readCommand: gatewayServiceReadCommand,
    readRuntime: gatewayServiceReadRuntime,
    restart: gatewayServiceRestart,
    uninstall: gatewayServiceUninstall,
    install: gatewayServiceInstall,
  })),
}));

vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable,
  resolveSystemdUserServiceAccount,
  readSystemdUserLingerStatus,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment,
}));

vi.mock("../commands/onboard-gateway-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-gateway-process.js")>()),
  startOnboardingGatewayProcess,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState,
}));

// mock-isolation: Onboarding handoff fixtures isolate the interactive terminal graph.
vi.mock("../tui/tui.js", () => ({ runTui }));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice: vi.fn(),
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus: async (
    ...args: Parameters<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>
  ) => resolveDefaultModelAuthStatus(...args),
  resolvePreferredProviderForAuthChoice: vi.fn(),
  warnIfModelConfigLooksOff: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
}));

vi.mock("./setup.secret-input.js", () => ({
  resolveSetupSecretInputString,
}));

vi.mock("./setup.completion.js", () => ({
  setupWizardShellCompletion,
}));

import { createFinalizeArgs, createRuntime } from "./setup.finalize.fixtures.test-support.js";
import { finalizeSetupWizard } from "./setup.finalize.js";

function requireMockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

describe("finalizeSetupWizard", () => {
  beforeEach(() => {
    readPin.mockReset().mockReturnValue({ revision: "empty", stored: false });
    resetFinalizeMocks();
    healthCommand.mockReset().mockResolvedValue(undefined);
    buildGatewayInstallPlan.mockClear();
    gatewayServiceReadRuntime.mockReset();
    inspectWindowsGatewayFirewall.mockReset().mockResolvedValue({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    });
    resolveDefaultModelAuthStatus.mockReset().mockReturnValue({
      provider: "anthropic",
      model: "test-model",
      status: "ready",
    });
    resolveDefaultModelCatalogFacts.mockReset().mockReturnValue({});
  });

  it("keeps real health authentication on the setup Gateway despite ambient endpoints", async ({
    signal,
  }) => {
    const actual =
      await vi.importActual<typeof import("../commands/health.js")>("../commands/health.js");
    await withSetupHealthGateway("classic", signal, async ({ config, port, pid, password }) => {
      gatewayServiceReadRuntime.mockResolvedValue({ status: "running", pid });
      resolveSetupSecretInputString.mockResolvedValue(password);
      probeGatewayReachable.mockResolvedValue({ ok: true });
      let completed = false;
      healthCommand.mockImplementation(async (...args) => {
        await actual.healthCommandNonExiting(...args);
        completed = true;
      });
      await finalizeSetupWizard(
        createFinalizeArgs("quickstart", {
          opts: { skipHealth: false, skipUi: true },
          nextConfig: config,
          settings: { authMode: "trusted-proxy", port },
        }),
      );
      expect(completed).toBe(true);
      expect(config.gateway?.auth?.mode).toBe("trusted-proxy");
    });
  }, 90_000);

  // A preserved trusted-proxy gateway authenticates same-host clients with the
  // saved local password and has no token fallback, so finalization has to send
  // it or it reports a healthy Gateway as unreachable.
  it("probes a trusted-proxy gateway with its saved local password", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password"; // pragma: allowlist secret
    resolveSetupSecretInputString.mockResolvedValueOnce("resolved-gateway-password");
    probeGatewayReachable.mockResolvedValueOnce({ ok: true });
    resolveLocalControlUiProbeLinks.mockReturnValue({
      httpUrl: "http://127.0.0.1:19861/",
      wsUrl: "ws://127.0.0.1:19861",
    });
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => false) });

    try {
      await finalizeSetupWizard(
        createFinalizeArgs("quickstart", {
          opts: { skipHealth: false },
          settings: { authMode: "trusted-proxy", port: 19861 },
          nextConfig: {
            gateway: {
              port: 19861,
              auth: {
                mode: "trusted-proxy",
                trustedProxy: { userHeader: "x-forwarded-user" },
                password: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_GATEWAY_PASSWORD",
                },
              },
              trustedProxies: ["10.0.0.5"],
            },
          },
          prompter,
          runtime: createRuntime(),
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    const probeParams = requireMockArg(probeGatewayReachable) as { password?: string };
    expect(probeParams.password).toBe("resolved-gateway-password"); // pragma: allowlist secret
    expect(healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "resolved-gateway-password",
        localPortOverride: 19861,
      }),
      expect.anything(),
    );
  });

  // A configured local password may come only from the environment, the same
  // way the Gateway credential owner resolves it.
  it("probes a trusted-proxy gateway with an ambient environment password", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "ambient-gateway-password"; // pragma: allowlist secret
    resolveSetupSecretInputString.mockResolvedValueOnce(undefined);
    const prompter = buildWizardPrompter({ confirm: vi.fn(async () => false) });

    try {
      await finalizeSetupWizard(
        createFinalizeArgs("quickstart", {
          settings: { authMode: "trusted-proxy" },
          nextConfig: {
            gateway: {
              auth: {
                mode: "trusted-proxy",
                trustedProxy: { userHeader: "x-forwarded-user" },
              },
              trustedProxies: ["10.0.0.5"],
            },
          },
          prompter,
          runtime: createRuntime(),
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    const probeParams = requireMockArg(probeGatewayReachable) as { password?: string };
    expect(probeParams.password).toBe("ambient-gateway-password"); // pragma: allowlist secret
  });

  // The local password is accepted only for a direct-local request, so the
  // same-host terminal handoff must not use the advertised LAN address.
  it("hands off a LAN trusted-proxy gateway to the local loopback endpoint", async () => {
    resolveAdvertisedControlUiLinks.mockResolvedValueOnce({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
    resolveLocalControlUiProbeLinks.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    gatewayServiceIsLoaded.mockResolvedValue(true);
    buildGatewayInstallPlan.mockRejectedValueOnce(new Error("replacement plan failed"));
    probeGatewayReachable.mockResolvedValue({ ok: true });
    resolveSetupSecretInputString.mockResolvedValueOnce("local-gateway-password");
    const prompter = buildWizardPrompter({
      select: vi.fn().mockResolvedValueOnce("reinstall").mockResolvedValueOnce("tui"),
    });

    await finalizeSetupWizard(
      createFinalizeArgs("quickstart", {
        opts: { installDaemon: true, skipUi: false },
        settings: { authMode: "trusted-proxy", bind: "lan" },
        nextConfig: {
          gateway: {
            bind: "lan",
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user" },
              password: "local-gateway-password", // pragma: allowlist secret
            },
            trustedProxies: ["10.0.0.5"],
          },
        },
        prompter,
      }),
    );

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        boundGateway: expect.objectContaining({
          url: "ws://127.0.0.1:18789",
          password: "local-gateway-password", // pragma: allowlist secret
        }),
      }),
    );
  });

  // A shared token is not a proxy credential, and a preserved trusted-proxy
  // setup need not have one, so completion must not advertise token commands.
  it("omits token guidance when a trusted-proxy gateway completes", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const note = vi.fn(async (_message: unknown) => {});
    const prompter = buildWizardPrompter({
      note: note as never,
      confirm: vi.fn(async () => false),
    });

    await finalizeSetupWizard(
      createFinalizeArgs("quickstart", {
        settings: { authMode: "trusted-proxy" },
        nextConfig: {
          gateway: {
            auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
            trustedProxies: ["10.0.0.5"],
          },
        },
        prompter,
        runtime: createRuntime(),
      }),
    );

    const noted = note.mock.calls.map((call) => String(call[0]));
    expect(noted.join("\n")).not.toMatch(/auth-token --show|generate-gateway-token/);
  });
});
