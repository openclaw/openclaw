// Trusted-proxy finalization tests cover credential resolution, probing, and
// terminal handoff for a preserved trusted-proxy gateway.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type * as AuthChoiceModelCheck from "../commands/auth-choice.model-check.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";

type DefaultModelAuthStatus = ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>;
type DefaultModelCatalogFacts = ReturnType<
  typeof AuthChoiceModelCheck.resolveDefaultModelCatalogFacts
>;

const readPin = vi.hoisted(() => vi.fn());
vi.mock("../daemon/runtime-pin-state.js", () => ({ readDaemonRuntimePinForInstall: readPin }));

const runTui = vi.hoisted(() => vi.fn<(options: unknown) => Promise<void>>(async () => {}));
const setupCleanupExitTimer = vi.hoisted(() => ({ unref: vi.fn() }));
const scheduleProcessExitAfterTuiReturn = vi.hoisted(() => vi.fn(() => setupCleanupExitTimer));
const cancelProcessExitAfterTuiReturn = vi.hoisted(() => vi.fn());
const resolveTuiShutdownHardExitMs = vi.hoisted(() => vi.fn(() => 122_000));
const restoreTerminalState = vi.hoisted(() => vi.fn());
const probeGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const waitForGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const resolveControlUiHandoffTarget = vi.hoisted(() =>
  vi.fn(async (params: { config: OpenClawConfig }) => ({
    documentUrl: "http://127.0.0.1:18789/",
    tlsConfig: params.config.gateway?.tls,
  })),
);
const waitForControlUiDocument = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      url: string;
      tlsConfig?: GatewayTlsConfig;
      onPending?: () => void;
    }): Promise<{ ready: true } | { ready: false; reason: string }> => ({ ready: true }),
  ),
);
const resolveAdvertisedControlUiLinks = vi.hoisted(() =>
  vi.fn(async () => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);
const resolveLocalControlUiProbeLinks = vi.hoisted(() =>
  vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
);
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const resolveDefaultModelAuthStatus = vi.hoisted(() =>
  vi.fn<() => DefaultModelAuthStatus>(() => ({
    provider: "anthropic",
    model: "claude-opus-4-8",
    status: "ready",
    hasAuth: true,
  })),
);
const resolveDefaultModelCatalogFacts = vi.hoisted(() =>
  vi.fn<() => DefaultModelCatalogFacts>(() => ({})),
);
const loadModelCatalog = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => Promise<unknown[]>>(async () => []),
);
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async (_params?: { warn?: (message: string, title?: string) => void }) => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
    environmentValueSources: {},
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
const gatewayServiceReadCommand = vi.hoisted(() => vi.fn());
const startGatewayService = vi.hoisted(() => vi.fn());
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const resolveSystemdUserServiceAccount = vi.hoisted(() =>
  vi.fn(() => "test-user" as string | null),
);
const readSystemdUserLingerStatus = vi.hoisted(() =>
  vi.fn(async () => ({ user: "test-user", linger: "yes" as const })),
);
const resolveSetupSecretInputString = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(async () => undefined),
);
const resolveExistingKey = vi.hoisted(() =>
  vi.fn<(config: OpenClawConfig, provider: string) => string | undefined>(() => undefined),
);
const hasExistingKey = vi.hoisted(() =>
  vi.fn<(config: OpenClawConfig, provider: string) => boolean>(() => false),
);
const hasKeyInEnv = vi.hoisted(() =>
  vi.fn<(entry: Pick<PluginWebSearchProviderEntry, "envVars">) => boolean>(() => false),
);
const listConfiguredWebSearchProviders = vi.hoisted(() =>
  vi.fn<(params?: { config?: OpenClawConfig }) => PluginWebSearchProviderEntry[]>(() => []),
);
const hasAuthProfileForProvider = vi.hoisted(() =>
  vi.fn<
    (params: {
      provider: string;
      agentDir?: string;
      includeExternalCli?: boolean;
      type?: string;
    }) => boolean
  >(() => false),
);
const isContainerEnvironment = vi.hoisted(() => vi.fn(() => false));
const startGatewayServer = vi.hoisted(() =>
  vi.fn(async () => ({
    close: vi.fn(async () => {}),
  })),
);
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

vi.mock("../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [
    { value: "node", label: "Node" },
    { value: "bun", label: "Bun 1.4+" },
  ],
}));

vi.mock("../commands/health-format.js", () => ({
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

vi.mock("../daemon/service.js", () => ({
  describeGatewayServiceRestart: vi.fn((serviceNoun: string, result: { outcome: string }) =>
    result.outcome === "scheduled"
      ? {
          scheduled: true,
          daemonActionResult: "scheduled",
          message: `restart scheduled, ${serviceNoun.toLowerCase()} will restart momentarily`,
          progressMessage: `${serviceNoun} service restart scheduled.`,
        }
      : {
          scheduled: false,
          daemonActionResult: "restarted",
          message: `${serviceNoun} service restarted.`,
          progressMessage: `${serviceNoun} service restarted.`,
        },
  ),
  formatGatewayServiceStartRepairIssues: (issues: Array<{ message: string }>) =>
    issues.map((issue) => issue.message).join("; "),
  startGatewayService,
  resolveGatewayService: vi.fn(() => ({
    label: "Mock Platform Service",
    isLoaded: gatewayServiceIsLoaded,
    readCommand: gatewayServiceReadCommand,
    restart: gatewayServiceRestart,
    uninstall: gatewayServiceUninstall,
    install: gatewayServiceInstall,
  })),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
  resolveSystemdUserServiceAccount,
  readSystemdUserLingerStatus,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment,
}));

vi.mock("../gateway/server.js", () => ({
  startGatewayServer,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState,
}));

vi.mock("../tui/tui.js", () => ({
  cancelProcessExitAfterTuiReturn,
  resolveTuiShutdownHardExitMs,
  runTui,
  scheduleProcessExitAfterTuiReturn,
}));

vi.mock("../commands/auth-choice.js", () => ({
  applyAuthChoice: vi.fn(),
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus,
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

import { finalizeSetupWizard } from "./setup.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

type FinalizeArgs = Parameters<typeof finalizeSetupWizard>[0];

type FinalizeArgsOverrides = Omit<Partial<FinalizeArgs>, "flow" | "opts" | "settings"> & {
  opts?: Partial<FinalizeArgs["opts"]>;
  settings?: Partial<FinalizeArgs["settings"]>;
};

function createLaterPrompter() {
  return buildWizardPrompter({
    select: vi.fn(async () => "later") as never,
    confirm: vi.fn(async () => false),
  });
}

function createFinalizeArgs(
  flow: FinalizeArgs["flow"],
  overrides: FinalizeArgsOverrides = {},
): FinalizeArgs {
  const { opts, settings, ...rest } = overrides;
  return {
    flow,
    opts: {
      acceptRisk: true,
      authChoice: "skip",
      installDaemon: false,
      skipHealth: true,
      skipUi: flow === "advanced",
      ...opts,
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
      ...settings,
    },
    prompter: createLaterPrompter(),
    runtime: createRuntime(),
    ...rest,
  };
}

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
    runTui.mockClear();
    setupCleanupExitTimer.unref.mockClear();
    scheduleProcessExitAfterTuiReturn.mockReset();
    scheduleProcessExitAfterTuiReturn.mockReturnValue(setupCleanupExitTimer);
    cancelProcessExitAfterTuiReturn.mockClear();
    resolveTuiShutdownHardExitMs.mockClear();
    restoreTerminalState.mockClear();
    probeGatewayReachable.mockReset();
    probeGatewayReachable.mockResolvedValue({ ok: false, detail: "offline" });
    waitForGatewayReachable.mockReset();
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    resolveControlUiHandoffTarget.mockReset();
    resolveControlUiHandoffTarget.mockImplementation(async ({ config }) => ({
      documentUrl: "http://127.0.0.1:18789/",
      tlsConfig: config.gateway?.tls,
    }));
    waitForControlUiDocument.mockReset();
    waitForControlUiDocument.mockResolvedValue({ ready: true });
    resolveAdvertisedControlUiLinks.mockReset();
    resolveAdvertisedControlUiLinks.mockResolvedValue({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    });
    resolveLocalControlUiProbeLinks.mockReset();
    resolveLocalControlUiProbeLinks.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    });
    setupWizardShellCompletion.mockClear();
    healthCommand.mockReset();
    healthCommand.mockResolvedValue(undefined);
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset();
    gatewayServiceIsLoaded.mockResolvedValue(false);
    gatewayServiceReadCommand.mockReset();
    gatewayServiceReadCommand.mockResolvedValue(null);
    startGatewayService.mockReset();
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    resolveSystemdUserServiceAccount.mockReset();
    resolveSystemdUserServiceAccount.mockReturnValue("test-user");
    readSystemdUserLingerStatus.mockReset();
    readSystemdUserLingerStatus.mockResolvedValue({ user: "test-user", linger: "yes" });
    resolveSetupSecretInputString.mockReset();
    resolveSetupSecretInputString.mockResolvedValue(undefined);
    resolveExistingKey.mockReset();
    resolveExistingKey.mockReturnValue(undefined);
    hasExistingKey.mockReset();
    hasExistingKey.mockReturnValue(false);
    hasKeyInEnv.mockReset();
    hasKeyInEnv.mockReturnValue(false);
    listConfiguredWebSearchProviders.mockReset();
    listConfiguredWebSearchProviders.mockReturnValue([]);
    hasAuthProfileForProvider.mockReset();
    hasAuthProfileForProvider.mockReturnValue(false);
    isContainerEnvironment.mockReset();
    isContainerEnvironment.mockReturnValue(false);
    startGatewayServer.mockReset();
    startGatewayServer.mockResolvedValue({ close: vi.fn(async () => {}) });
    inspectWindowsGatewayFirewall.mockReset();
    inspectWindowsGatewayFirewall.mockResolvedValue({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    });
    resolveDefaultModelAuthStatus.mockReset();
    resolveDefaultModelAuthStatus.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-8",
      status: "ready",
      hasAuth: true,
    });
    resolveDefaultModelCatalogFacts.mockReset();
    resolveDefaultModelCatalogFacts.mockReturnValue({});
    loadModelCatalog.mockReset();
    loadModelCatalog.mockResolvedValue([]);
  });

  // A preserved trusted-proxy gateway authenticates same-host clients with the
  // saved local password and has no token fallback, so finalization has to send
  // it or it reports a healthy Gateway as unreachable.
  it("probes a trusted-proxy gateway with its saved local password", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password"; // pragma: allowlist secret
    resolveSetupSecretInputString.mockResolvedValueOnce("resolved-gateway-password");
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
