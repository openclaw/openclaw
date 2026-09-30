// Setup finalize tests cover writing final onboarding config and artifacts.
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { PreparedModelCatalogConfigReplacedError } from "../agents/prepared-model-catalog.errors.js";
import type * as AuthChoiceModelCheck from "../commands/auth-choice.model-check.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import * as programArgs from "../daemon/program-args.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { SupervisorDisplayGuidance } from "../plugins/supervisor-guidance.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { registerWizardExternalSupervisorTests } from "./setup.external-supervision.test-support.js";
import {
  createFinalizeArgs,
  createLaterPrompter,
  createRuntime,
  type FinalizeArgs,
  type FinalizeArgsOverrides,
} from "./setup.finalize.fixtures.test-support.js";
import {
  createRuntimeProbeResult,
  expectNoteContains,
  expectNoteTitleNotCalled,
  withPlatform,
  expectNoteNotContains,
} from "./setup.finalize.test-support.js";

type DefaultModelAuthStatus = ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>;
type DefaultModelCatalogFacts = ReturnType<
  typeof AuthChoiceModelCheck.resolveDefaultModelCatalogFacts
>;

const resolveSupervisorGuidance = vi.hoisted(() =>
  vi.fn<() => Promise<SupervisorDisplayGuidance | undefined>>(),
);
vi.mock("../plugins/supervisor-guidance-runtime.js", () => ({
  resolveExternalSupervisorGuidance: resolveSupervisorGuidance,
}));

const readPin = vi.hoisted(() => vi.fn());
vi.mock("../daemon/runtime-pin-state.js", () => ({ readDaemonRuntimePinForInstall: readPin }));
const runExec = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec,
}));

const runTui = vi.hoisted(() => vi.fn<(options: unknown) => Promise<void>>(async () => {}));
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
const resolveDefaultModelAuthStatus = vi.hoisted(() => vi.fn<() => DefaultModelAuthStatus>());
const resolveDefaultModelCatalogFacts = vi.hoisted(() =>
  vi.fn<() => DefaultModelCatalogFacts>(() => ({})),
);
const loadModelCatalog = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => Promise<unknown[]>>(async () => []),
);
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn<typeof import("../commands/daemon-install-helpers.js").buildGatewayInstallPlan>(
    async () => ({
      runtime: "node",
      programArguments: [],
      workingDirectory: "/tmp",
      environment: {},
      environmentValueSources: {},
    }),
  ),
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
const inspectWindowsGatewayFirewall = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

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

// mock-isolation: Onboarding handoff fixtures isolate the interactive terminal graph.
vi.mock("../tui/tui.js", () => ({ runTui }));

vi.mock("../commands/auth-choice.model-check.js", () => ({
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus,
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

import { ensureGatewayServiceForOnboarding, finalizeSetupWizard } from "./setup.finalize.js";

function createWebSearchProviderEntry(
  provider: Pick<PluginWebSearchProviderEntry, "id" | "label" | "envVars"> &
    Partial<Pick<PluginWebSearchProviderEntry, "authProviderId" | "requiresCredential">>,
): PluginWebSearchProviderEntry {
  return {
    pluginId: `plugin-${provider.id}`,
    hint: "",
    placeholder: "",
    signupUrl: "https://example.test/search",
    credentialPath: `plugins.entries.${provider.id}.config.webSearch.apiKey`,
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    createTool: () => null,
    ...provider,
  };
}

function createServiceSetupArgs(
  overrides: Partial<Parameters<typeof ensureGatewayServiceForOnboarding>[0]> = {},
): Parameters<typeof ensureGatewayServiceForOnboarding>[0] {
  return {
    flow: "quickstart",
    opts: {},
    nextConfig: {},
    settings: { port: 18789 },
    prompter: createLaterPrompter(),
    runtime: createRuntime(),
    ...overrides,
  };
}

function createSearchConfig(provider = "firecrawl"): OpenClawConfig {
  return { tools: { web: { search: { provider, enabled: true } } } };
}

function finalize(flow: FinalizeArgs["flow"], overrides: FinalizeArgsOverrides = {}) {
  return finalizeSetupWizard(createFinalizeArgs(flow, overrides));
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
    resolveSupervisorGuidance.mockReset().mockResolvedValue(undefined);
    readPin.mockReset().mockReturnValue({ revision: "empty", stored: false });
    runExec.mockReset().mockResolvedValue(createRuntimeProbeResult());
    runTui.mockClear();
    restoreTerminalState.mockClear();
    probeGatewayReachable.mockReset().mockResolvedValue({ ok: false, detail: "offline" });
    waitForGatewayReachable.mockReset().mockResolvedValue({ ok: true });
    resolveControlUiHandoffTarget.mockReset().mockImplementation(async ({ config }) => ({
      documentUrl: "http://127.0.0.1:18789/",
      tlsConfig: config.gateway?.tls,
    }));
    waitForControlUiDocument.mockReset().mockResolvedValue({ ready: true });
    resolveAdvertisedControlUiLinks.mockReset().mockResolvedValue({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    });
    resolveLocalControlUiProbeLinks.mockReset().mockReturnValue({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    });
    setupWizardShellCompletion.mockClear();
    healthCommand.mockReset().mockResolvedValue(undefined);
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset().mockResolvedValue(false);
    gatewayServiceReadCommand.mockReset().mockResolvedValue(null);
    startGatewayService.mockReset();
    gatewayServiceRestart.mockReset().mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset().mockResolvedValue(true);
    resolveSystemdUserServiceAccount.mockReset().mockReturnValue("test-user");
    readSystemdUserLingerStatus.mockReset().mockResolvedValue({ user: "test-user", linger: "yes" });
    resolveSetupSecretInputString.mockReset().mockResolvedValue(undefined);
    resolveExistingKey.mockReset().mockReturnValue(undefined);
    hasExistingKey.mockReset().mockReturnValue(false);
    hasKeyInEnv.mockReset().mockReturnValue(false);
    listConfiguredWebSearchProviders.mockReset().mockReturnValue([]);
    hasAuthProfileForProvider.mockReset().mockReturnValue(false);
    isContainerEnvironment.mockReset().mockReturnValue(false);
    startGatewayServer.mockReset().mockResolvedValue({ close: vi.fn(async () => {}) });
    inspectWindowsGatewayFirewall.mockReset().mockResolvedValue({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    });
    resolveDefaultModelAuthStatus.mockReset().mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-8",
      status: "ready",
      hasAuth: true,
    });
    resolveDefaultModelCatalogFacts.mockReset().mockReturnValue({});
    loadModelCatalog.mockReset().mockResolvedValue([]);
  });

  it("resolves gateway password SecretRef for probe but omits auth from TUI hatch", async () => {
    resolveSetupSecretInputString.mockResolvedValueOnce("resolved-gateway-password");
    const prompter = createLaterPrompter();
    const runtime = createRuntime();

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "resolved-gateway-password" }, async () => {
      await finalizeSetupWizard(
        createFinalizeArgs("quickstart", {
          settings: { authMode: "password" },
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
          },
          prompter,
          runtime,
        }),
      );
    });

    const probeParams = requireMockArg(probeGatewayReachable) as {
      url?: string;
      password?: string;
    };
    expect(probeParams.url).toBe("ws://127.0.0.1:18789");
    expect(probeParams.password).toBe("resolved-gateway-password"); // pragma: allowlist secret
    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      message: undefined,
      initialMessageTimeoutMs: 300_000,
    });
  });

  it("waits for the served dashboard before announcing its URL", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const stop = vi.fn();
    const prompter = buildWizardPrompter({
      progress: vi.fn(() => ({ update: vi.fn(), stop })),
    });
    let resolveDocument: ((value: { ready: true }) => void) | undefined;
    waitForControlUiDocument.mockImplementation(async ({ onPending }) => {
      onPending?.();
      return await new Promise<{ ready: true }>((resolve) => {
        resolveDocument = resolve;
      });
    });

    const finalizing = finalizeSetupWizard(createFinalizeArgs("quickstart", { prompter }));
    await vi.waitFor(() => expect(waitForControlUiDocument).toHaveBeenCalledOnce());
    expectNoteTitleNotCalled(prompter, "Control UI");
    expect(prompter.outro).not.toHaveBeenCalled();
    expect(prompter.progress).toHaveBeenCalledWith("Preparing the Control UI…");

    resolveDocument?.({ ready: true });
    await finalizing;

    expect(stop).toHaveBeenCalledOnce();
    expectNoteContains(prompter, "Web UI: http://127.0.0.1:18789", "Control UI");
    expect(prompter.outro).toHaveBeenCalledWith(
      "Onboarding complete. Use the dashboard link above to control OpenClaw.",
    );
    expect(runTui).toHaveBeenCalledOnce();
    expect(vi.mocked(prompter.outro).mock.invocationCallOrder[0]).toBeLessThan(
      runTui.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the reachable Gateway and TUI when dashboard preparation fails", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    waitForControlUiDocument.mockResolvedValue({
      ready: false,
      reason: "Control UI build failed: missing startup.js",
    });
    const prompter = createLaterPrompter();
    const args = createFinalizeArgs("quickstart", { prompter });
    const gatewayToken = ["classic", "token"].join("-");

    await finalizeSetupWizard({
      ...args,
      settings: { ...args.settings, gatewayToken },
    });

    expect(args.runtime.error).toHaveBeenCalledWith("Control UI build failed: missing startup.js");
    expectNoteContains(prompter, "Gateway: reachable", "Control UI");
    expectNoteNotContains(prompter, "Web UI:");
    expectNoteNotContains(prompter, gatewayToken);
    expect(prompter.outro).toHaveBeenCalledWith(
      "OpenClaw is ready. When you're ready: openclaw dashboard",
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        config: args.nextConfig,
        boundGateway: {
          url: "ws://127.0.0.1:18789",
          token: gatewayToken,
        },
      }),
    );
    const tuiOptions = runTui.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(tuiOptions).not.toHaveProperty("url");
    expect(tuiOptions).not.toHaveProperty("token");
    expect(tuiOptions).toMatchObject({ initialMessageTimeoutMs: 300_000 });
    expect(tuiOptions).not.toHaveProperty("timeoutMs");
  });

  it("does not wait for dashboard assets when the UI is disabled", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const prompter = createLaterPrompter();

    await finalize("quickstart", {
      nextConfig: { gateway: { controlUi: { enabled: false } } },
      settings: { gatewayToken: "offline-token" },
      prompter,
    });

    expect(resolveControlUiHandoffTarget).not.toHaveBeenCalled();
    expect(waitForControlUiDocument).not.toHaveBeenCalled();
    expectNoteNotContains(prompter, "Web UI:");
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
  });

  it("probes the canonical loopback dashboard for custom TLS Gateway paths", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const tlsConfig = { enabled: true, caPath: "/gateway/clients.pem" };
    resolveControlUiHandoffTarget.mockResolvedValueOnce({
      documentUrl: "https://127.0.0.1:19876/dashboard/",
      tlsConfig,
    });
    const nextConfig: OpenClawConfig = {
      gateway: {
        port: 18789,
        bind: "loopback",
        tls: tlsConfig,
      },
    };
    await finalize("quickstart", {
      baseConfig: { gateway: { controlUi: { basePath: "/dashboard" } } },
      nextConfig,
      settings: {
        port: 19876,
        bind: "custom",
        customBindHost: "10.0.0.5",
      },
    });

    expect(resolveControlUiHandoffTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            port: 19876,
            bind: "custom",
            customBindHost: "10.0.0.5",
            controlUi: { basePath: "/dashboard" },
            tls: tlsConfig,
          }),
        }),
        env: expect.objectContaining({ OPENCLAW_GATEWAY_PORT: "19876" }),
      }),
    );
    expect(waitForControlUiDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://127.0.0.1:19876/dashboard/",
        tlsConfig,
      }),
    );
  });

  it("advertises LAN Control UI links while probing the local gateway", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    resolveAdvertisedControlUiLinks.mockResolvedValueOnce({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
    resolveLocalControlUiProbeLinks.mockReturnValue({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    const prompter = createLaterPrompter();
    await finalize("advanced", {
      opts: { skipHealth: false, skipUi: false },
      nextConfig: { gateway: { bind: "lan" } },
      settings: { bind: "lan" },
      prompter,
    });

    expect(resolveAdvertisedControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", port: 18789 }),
    );
    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expectNoteContains(prompter, "http://10.211.55.3:18789/", "Control UI");
    expectNoteContains(prompter, "ws://10.211.55.3:18789", "Control UI");
    expect(inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expectNoteContains(
      prompter,
      "Windows firewall: if another device cannot connect to the LAN URL",
      "Control UI",
    );
  });

  it("finishes without a hatch message when the prepared catalog owner was replaced", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    loadModelCatalog.mockRejectedValueOnce(
      new PreparedModelCatalogConfigReplacedError("/tmp/replaced-agent"),
    );
    const prompter = createLaterPrompter();

    await expect(
      finalizeSetupWizard(createFinalizeArgs("quickstart", { prompter })),
    ).resolves.toEqual({ launchedTui: true });

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        message: undefined,
      }),
    );
    expect(resolveDefaultModelCatalogFacts).not.toHaveBeenCalled();
    expect(resolveDefaultModelAuthStatus).not.toHaveBeenCalled();
  });

  it("propagates unrelated prepared catalog failures", async () => {
    const error = new Error("catalog read failed");
    loadModelCatalog.mockRejectedValueOnce(error);

    await expect(finalizeSetupWizard(createFinalizeArgs("quickstart"))).rejects.toBe(error);

    expect(runTui).not.toHaveBeenCalled();
  });

  it("passes physical catalog routes into the bootstrap auth decision", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const catalog = [
      {
        id: "gpt-5.4-nano",
        name: "GPT 5.4 Nano",
        provider: "openai",
      },
    ];
    const observedRoutes = [
      {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
    ];
    loadModelCatalog.mockResolvedValueOnce(catalog);
    resolveDefaultModelCatalogFacts.mockReturnValueOnce({ observedRoutes });
    const prompter = buildWizardPrompter();
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.4-nano" },
        entries: { main: { agentDir: "/tmp/custom-agent" } },
      },
    } satisfies OpenClawConfig;

    await finalizeSetupWizard(createFinalizeArgs("quickstart", { prompter, nextConfig }));

    expect(loadModelCatalog).toHaveBeenCalledWith({ config: nextConfig, readOnly: true });
    expect(resolveDefaultModelCatalogFacts).toHaveBeenCalledWith(nextConfig, catalog, {
      routeVariants: catalog,
    });
    expect(resolveDefaultModelAuthStatus).toHaveBeenCalledWith(nextConfig, {
      agentDir: "/tmp/custom-agent",
      observedRoutes,
    });
    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      message: "Wake up, my friend!",
      initialMessageTimeoutMs: 300_000,
    });
  });

  it("skips the doomed hatch seed message and warns when model auth is missing", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    resolveDefaultModelAuthStatus.mockReturnValueOnce({
      provider: "openai",
      model: "gpt-5.5",
      status: "missing",
      hasAuth: false,
    });
    const prompter = buildWizardPrompter();

    await finalize("quickstart", {
      prompter,
      nextConfig: {
        agents: {
          entries: { main: { agentDir: "/tmp/custom-agent" } },
        },
      },
    });

    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }));
    expect(resolveDefaultModelAuthStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: {
          entries: { main: { agentDir: "/tmp/custom-agent" } },
        },
      }),
      { agentDir: "/tmp/custom-agent" },
    );
    expectNoteContains(
      prompter,
      'No credentials are configured for provider "openai"',
      "Model auth missing",
    );
  });

  it("hatches without a seed and omits setup advice for an incompatible model route", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    resolveDefaultModelAuthStatus.mockReturnValueOnce({
      provider: "openai",
      model: "gpt-5.6",
      status: "incompatible",
      hasAuth: false,
      code: "auth_mode_unsupported",
      message: "gpt-5.6 requires OpenAI Platform API-key authentication.",
    });
    const prompter = buildWizardPrompter();

    await finalizeSetupWizard(createFinalizeArgs("quickstart", { prompter }));

    expect(runTui).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }));
    expectNoteTitleNotCalled(prompter, "Model auth missing");
    expectNoteNotContains(prompter, "No credentials are configured");
    expectNoteNotContains(prompter, "openclaw configure --section model");
  });

  it("does not resend the bootstrap hatch message on setup reruns", async () => {
    vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const prompter = buildWizardPrompter();

    await finalizeSetupWizard(
      createFinalizeArgs("quickstart", { hadExistingConfig: true, prompter }),
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      deliver: false,
      message: undefined,
      initialMessageTimeoutMs: 300_000,
    });
  });

  it("restores terminal state after failed TUI hatch", async () => {
    runTui.mockRejectedValueOnce(new Error("TUI exited with code 1"));
    const prompter = createLaterPrompter();

    await expect(
      finalizeSetupWizard(
        createFinalizeArgs("advanced", {
          opts: { skipUi: false },
          settings: { gatewayToken: "test-token" },
          prompter,
        }),
      ),
    ).rejects.toThrow("TUI exited with code 1");

    expect(restoreTerminalState).toHaveBeenCalledWith("pre-setup tui", {
      resumeStdinIfPaused: false,
    });
    expect(restoreTerminalState).toHaveBeenCalledWith("post-setup tui", {
      resumeStdinIfPaused: false,
    });
  });

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const prompter = createLaterPrompter();
    const runtime = createRuntime();
    buildGatewayInstallPlan.mockResolvedValueOnce({
      runtime: "node",
      programArguments: [],
      workingDirectory: "/tmp",
      environment: {
        DISCORD_BOT_TOKEN: "discord-test-token",
      },
      environmentValueSources: {
        DISCORD_BOT_TOKEN: "file",
      },
    });

    await finalize("advanced", {
      opts: { installDaemon: true },
      settings: { gatewayToken: "session-token" },
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
      prompter,
      runtime,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(gatewayServiceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentValueSources: {
          DISCORD_BOT_TOKEN: "file",
        },
      }),
    );
  });

  it("reports Bun for a Bun-only QuickStart install", async () => {
    const { buildGatewayInstallPlan: realPlan } = await vi.importActual<
      typeof import("../commands/daemon-install-helpers.js")
    >("../commands/daemon-install-helpers.js");
    const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.2" });
    const discoverNode = vi
      .spyOn(runtimePaths, "resolvePreferredNodePath")
      .mockResolvedValue(undefined);
    const probeBun = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
      status: "supported",
      version: "1.4.2",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    });
    const resolveArguments = vi
      .spyOn(programArgs, "resolveGatewayProgramArguments")
      .mockResolvedValue({ programArguments: [process.execPath, "/app/openclaw.mjs", "gateway"] });
    buildGatewayInstallPlan.mockImplementationOnce(realPlan);
    const prompter = buildWizardPrompter();
    try {
      const result = await ensureGatewayServiceForOnboarding(
        createServiceSetupArgs({ flow: "quickstart", opts: { installDaemon: true }, prompter }),
      );
      expect(result.gateway).toEqual({ status: "ready", action: "installed" });
      expect(resolveArguments).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: "bun", runtimePath: process.execPath }),
      );
      expectNoteContains(prompter, "QuickStart uses Bun", "Gateway service runtime");
      expectNoteNotContains(prompter, "QuickStart uses Node");
      expect(gatewayServiceInstall).toHaveBeenCalledOnce();
    } finally {
      discoverNode.mockRestore();
      probeBun.mockRestore();
      resolveArguments.mockRestore();
      if (bunVersion) {
        Object.defineProperty(process.versions, "bun", bunVersion);
      } else {
        delete process.versions.bun;
      }
    }
  });

  it("waits for gateway install warnings before installing the service", async () => {
    let acknowledgeWarning: (() => void) | undefined;
    const warningAcknowledged = new Promise<void>((resolve) => {
      acknowledgeWarning = resolve;
    });
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
      note: vi.fn(async (message: string) => {
        if (message === "Gateway install warning") {
          await warningAcknowledged;
        }
      }),
    });
    buildGatewayInstallPlan.mockImplementationOnce(async (params) => {
      params?.warn?.("Gateway install warning", "Gateway service");
      return {
        runtime: "node",
        programArguments: [],
        workingDirectory: "/tmp",
        environment: {},
        environmentValueSources: {},
      };
    });

    const finalizePromise = finalizeSetupWizard(
      createFinalizeArgs("advanced", { opts: { installDaemon: true }, prompter }),
    );
    await vi.waitFor(() => {
      expect(prompter.note).toHaveBeenCalledWith("Gateway install warning", "Gateway service");
    });
    expect(gatewayServiceInstall).not.toHaveBeenCalled();

    acknowledgeWarning?.();
    await finalizePromise;

    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  it("shows gateway install warnings when planning fails", async () => {
    const prompter = createLaterPrompter();
    buildGatewayInstallPlan.mockImplementationOnce(async (params) => {
      params?.warn?.("Gateway install warning", "Gateway service");
      throw new Error("plan failed");
    });

    await finalizeSetupWizard(
      createFinalizeArgs("advanced", { opts: { installDaemon: true }, prompter }),
    );

    expect(prompter.note).toHaveBeenCalledWith("Gateway install warning", "Gateway service");
    expectNoteContains(prompter, "plan failed", "Gateway");
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "linux", action: "installed" },
    { platform: "linux", action: "reused" },
    { platform: "linux", action: "skipped" },
    { platform: "win32", action: "installed" },
  ] as const)(
    "uses the $platform readiness budget after service $action",
    async ({ platform, action }) => {
      await withPlatform(platform, async () => {
        gatewayServiceIsLoaded.mockResolvedValue(action !== "installed");
        const choice = action === "reused" ? "skip" : "restart";
        const prompter = buildWizardPrompter(undefined, { defaultSelect: choice });

        await finalizeSetupWizard(
          createFinalizeArgs("quickstart", {
            opts: { installDaemon: action !== "skipped", skipHealth: false, skipUi: true },
            prompter,
          }),
        );

        if (action === "skipped") {
          expect(waitForGatewayReachable).not.toHaveBeenCalled();
          expectNoteContains(prompter, "openclaw gateway run", "Gateway");
          expect(prompter.outro).toHaveBeenCalledWith(
            expect.stringContaining("openclaw gateway run"),
          );
          return;
        }
        const managedStartup = action !== "reused";
        const startupTiming = resolveGatewayStartupTiming(platform);
        expect(waitForGatewayReachable).toHaveBeenCalledOnce();
        const timing = requireMockArg(waitForGatewayReachable) as {
          deadlineMs?: number;
          probeTimeoutMs?: number;
        };
        expect(timing.deadlineMs).toBe(managedStartup ? startupTiming.deadlineMs : 15_000);
        expect(timing.probeTimeoutMs ?? 1_500).toBe(
          managedStartup ? startupTiming.probeTimeoutMs : 1_500,
        );
      });
    },
  );

  it.each([false, true])(
    "detects the surviving gateway after failed reinstall (skipHealth=%s)",
    async (skipHealth) => {
      gatewayServiceIsLoaded.mockResolvedValue(true);
      buildGatewayInstallPlan.mockRejectedValueOnce(new Error("replacement plan failed"));
      probeGatewayReachable.mockResolvedValue({ ok: true });
      const prompter = buildWizardPrompter({
        select: vi.fn().mockResolvedValueOnce("reinstall").mockResolvedValueOnce("tui"),
      });

      await finalizeSetupWizard(
        createFinalizeArgs("quickstart", {
          opts: { installDaemon: true, skipHealth },
          prompter,
        }),
      );

      expect(gatewayServiceUninstall).not.toHaveBeenCalled();
      expect(gatewayServiceInstall).not.toHaveBeenCalled();
      expect(waitForGatewayReachable).not.toHaveBeenCalled();
      expect(probeGatewayReachable).toHaveBeenCalledOnce();
      expect(healthCommand).toHaveBeenCalledTimes(skipHealth ? 0 : 1);
      expect(runTui).toHaveBeenCalledWith(
        expect.objectContaining({ boundGateway: { url: "ws://127.0.0.1:18789" } }),
      );
      expectNoteContains(prompter, "replacement plan failed", "Gateway");
      expectNoteNotContains(prompter, "Gateway: not detected");
      expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("setup failed"));
    },
  );

  it("reports gateway installation failure without waiting for impossible health", async () => {
    gatewayServiceInstall.mockRejectedValueOnce(new Error("service install exploded"));
    const prompter = createLaterPrompter();
    const runtime = createRuntime();
    await finalize("advanced", {
      opts: { installDaemon: true, skipHealth: false },
      prompter,
      runtime,
    });

    expect(waitForGatewayReachable).not.toHaveBeenCalled();
    expect(probeGatewayReachable).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith("health failed");
    expectNoteContains(prompter, "service install exploded", "Gateway");
    expectNoteContains(prompter, "Gateway: not detected (offline)", "Control UI");
    expect(prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining("managed Mock Platform Service setup failed"),
    );
    expectNoteContains(prompter, "openclaw gateway status --deep", "Gateway");
    expectNoteContains(prompter, "openclaw gateway install --force", "Gateway");
    expectNoteNotContains(prompter, "openclaw gateway run");
    expectNoteNotContains(prompter, "openclaw gateway restart");
  });

  it("keeps managed readiness timeout recovery on the canonical service path", async () => {
    const detail = "gateway readiness timed out";
    waitForGatewayReachable.mockResolvedValue({ ok: false, detail });
    probeGatewayReachable.mockResolvedValue({ ok: false, detail });
    const prompter = createLaterPrompter();
    await finalize("advanced", {
      opts: { installDaemon: true, skipHealth: false },
      prompter,
    });

    expectNoteContains(prompter, "managed Mock Platform Service", "Gateway");
    expectNoteContains(prompter, "openclaw gateway status --deep", "Gateway");
    expectNoteContains(prompter, "openclaw gateway restart", "Gateway");
    expectNoteNotContains(prompter, "openclaw gateway run");
    expectNoteNotContains(prompter, "openclaw onboard --install-daemon");
    expectNoteNotContains(prompter, "openclaw gateway install --force");
  });

  registerWizardExternalSupervisorTests({
    resolveSupervisorGuidance,
    isSystemdUserServiceAvailable,
    isContainerEnvironment,
    createLaterPrompter,
    ensureGatewayServiceForOnboarding,
    createRuntime,
    gatewayServiceInstall,
    waitForGatewayReachable,
    probeGatewayReachable,
    finalizeSetupWizard,
    createFinalizeArgs,
    startGatewayServer,
    readSystemdUserLingerStatus,
    gatewayServiceIsLoaded,
    gatewayServiceRestart,
    startGatewayService,
  });

  it("installs a missing gateway service when onboarding resumes before installation", async () => {
    startGatewayService.mockResolvedValueOnce({
      outcome: "missing-install",
      state: {
        installed: false,
        loaded: false,
        running: false,
        env: process.env,
        command: null,
      },
    });

    const result = await ensureGatewayServiceForOnboarding(
      createServiceSetupArgs({ loadedAction: "resume" }),
    );

    expect(result.gateway).toEqual({ status: "ready", action: "installed" });
    expect(startGatewayService).toHaveBeenCalledOnce();
    expect(buildGatewayInstallPlan).toHaveBeenCalledOnce();
    expect(gatewayServiceInstall).toHaveBeenCalledOnce();
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
  });

  it("reuses a running gateway while resuming without restarting it", async () => {
    startGatewayService.mockResolvedValueOnce({
      outcome: "already-running",
      state: {
        installed: true,
        loaded: true,
        running: true,
        env: process.env,
        command: { programArguments: ["openclaw", "gateway"] },
      },
      issues: [],
    });

    const result = await ensureGatewayServiceForOnboarding(
      createServiceSetupArgs({ loadedAction: "resume" }),
    );

    expect(result.gateway).toEqual({ status: "ready", action: "reused" });
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(startGatewayService).toHaveBeenCalledOnce();
  });

  it("starts an installed but stopped gateway while resuming", async () => {
    const stopped = {
      installed: true,
      loaded: true,
      running: false,
      env: process.env,
      command: { programArguments: ["openclaw", "gateway"] },
    };
    startGatewayService.mockResolvedValueOnce({
      outcome: "started",
      state: { ...stopped, running: true },
    });

    const result = await ensureGatewayServiceForOnboarding(
      createServiceSetupArgs({ loadedAction: "resume" }),
    );

    expect(result.gateway).toEqual({ status: "ready", action: "started" });
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it("reports service definition repair failures without restarting on resume", async () => {
    const prompter = createLaterPrompter();
    startGatewayService.mockResolvedValueOnce({
      outcome: "repair-required",
      state: { installed: true, loaded: true, running: false },
      issues: [
        { code: "port-mismatch", message: "service is configured for another port" },
        { code: "missing-program", message: "service command points at a missing path" },
      ],
    });

    const result = await ensureGatewayServiceForOnboarding(
      createServiceSetupArgs({ prompter, loadedAction: "resume" }),
    );

    expect(result.gateway).toEqual({
      status: "failed",
      error: "service is configured for another port; service command points at a missing path",
    });
    expect(
      vi
        .mocked(prompter.note)
        .mock.calls.some(([message]) => message.includes("service is configured for another port")),
    ).toBe(false);
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it("never prints the reusable Gateway token during classic onboarding", async () => {
    const prompter = createLaterPrompter();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const runtime = { log: runtimeLog, error: runtimeError, exit: vi.fn() };
    probeGatewayReachable.mockResolvedValue({ ok: true });

    await finalize("advanced", {
      opts: { skipUi: false },
      settings: { gatewayToken: "session-token" },
      prompter,
      runtime,
    });

    const terminalOutput = [prompter.note, prompter.outro]
      .flatMap((writer) => vi.mocked(writer).mock.calls.flat())
      .join("\n");
    const runtimeOutput = [runtimeLog, runtimeError]
      .flatMap((writer) => writer.mock.calls.flat())
      .join("\n");
    expect(terminalOutput).toContain("http://127.0.0.1:18789");
    expect(terminalOutput).toContain("openclaw dashboard --no-open");
    for (const output of [terminalOutput, runtimeOutput]) {
      expect(output).not.toContain("session-token");
      expect(output).not.toContain("#token=");
    }
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

    await finalizeSetupWizard(
      createFinalizeArgs("advanced", { opts: { installDaemon: true }, prompter }),
    );

    expect(gatewayServiceRestart).toHaveBeenCalledTimes(1);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    expect(progressUpdate).toHaveBeenCalledWith("Restarting Gateway service...");
    expect(progressStop).toHaveBeenCalledWith("Gateway service restart scheduled.");
  });

  it("preserves the installed service when reinstall authentication fails", async () => {
    let installed = true;
    gatewayServiceIsLoaded.mockImplementation(async () => installed);
    gatewayServiceUninstall.mockImplementationOnce(async () => {
      installed = false;
    });
    resolveGatewayInstallToken.mockImplementationOnce(async () => ({
      warnings: [],
      unavailableReason: "replacement auth unavailable",
    }));
    const prompter = buildWizardPrompter(undefined, { defaultSelect: "reinstall" });

    const result = await ensureGatewayServiceForOnboarding(
      createFinalizeArgs("quickstart", { opts: { installDaemon: true }, prompter }),
    );

    expect(result.gateway.status).toBe("failed");
    expect(installed).toBe(true);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it.each([undefined, "node"] as const)(
    "passes installed pin intent to the reinstall owner (explicit=%s)",
    async (daemonRuntime) => {
      const pin = { runtime: "bun", path: "/opt/pinned/bun" };
      const expected = { revision: "pin-version", stored: true, pin };
      readPin.mockReturnValue(expected);
      let installed = true;
      gatewayServiceIsLoaded.mockImplementation(async () => installed);
      gatewayServiceUninstall.mockImplementationOnce(async () => {
        installed = false;
      });
      gatewayServiceInstall.mockImplementationOnce(async () => {
        expect(installed).toBe(true);
      });
      const managedDefinition = {
        programArguments: [
          "/usr/bin/node",
          "--max-old-space-size=24576",
          "--require=/tmp/service-preload.js",
          "/usr/local/bin/openclaw",
          "gateway",
        ],
        environment: { NODE_OPTIONS: "--max-heap-size=32768", UNRELATED: "not-persisted" },
      };
      const existingCommand = {
        programArguments: ["/operator/drop-in-wrapper", "gateway"],
        environment: { NODE_OPTIONS: "--max-old-space-size=1024" },
        managedDefinition,
        managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
      };
      gatewayServiceReadCommand.mockResolvedValue(existingCommand);
      const prompter = buildWizardPrompter(undefined, { defaultSelect: "reinstall" });

      const result = await ensureGatewayServiceForOnboarding(
        createFinalizeArgs("quickstart", {
          opts: { installDaemon: true, daemonRuntime },
          prompter,
        }),
      );

      expect(result.gateway).toEqual({ status: "ready", action: "installed" });
      expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          existingCommand,
        }),
      );
      expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("existingEnvironment");
      expect(gatewayServiceInstall).toHaveBeenCalledOnce();
      expect(gatewayServiceInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePinUpdate: { expected, pin: daemonRuntime ? undefined : pin },
        }),
      );
      expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: daemonRuntime ?? "bun",
          pinnedRuntimePath: daemonRuntime ? undefined : pin.path,
        }),
      );
      expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    },
  );

  it.each([
    { flow: "advanced", choice: "bun" },
    { flow: "advanced", choice: "node" },
    { flow: "quickstart", choice: "bun" },
  ] as const)(
    "reinstalls recorded Bun through $flow with choice=$choice",
    async ({ flow, choice }) => {
      const recordedPath = "/opt/recorded/bin/bun";
      runExec.mockResolvedValue(createRuntimeProbeResult("1.4.2"));
      gatewayServiceIsLoaded.mockResolvedValue(true);
      gatewayServiceReadCommand.mockResolvedValue({
        programArguments: [recordedPath, "/app/openclaw.mjs", "gateway"],
      });
      const prompter = buildWizardPrompter();
      const selectRuntime = vi
        .mocked(prompter.select)
        .mockResolvedValueOnce("reinstall")
        .mockResolvedValueOnce(choice);

      const result = await ensureGatewayServiceForOnboarding(
        createServiceSetupArgs({
          flow,
          opts: { installDaemon: true },
          prompter,
        }),
      );

      expect(result.gateway).toEqual({ status: "ready", action: "installed" });
      if (flow === "advanced") {
        expect(selectRuntime).toHaveBeenCalledWith(
          expect.objectContaining({ initialValue: "bun" }),
        );
      }
      expect(selectRuntime).toHaveBeenCalledTimes(flow === "advanced" ? 2 : 1);
      expect(requireMockArg(buildGatewayInstallPlan)).toMatchObject({
        runtime: choice,
        runtimePath: choice === "bun" ? recordedPath : undefined,
        pinnedRuntimePath: undefined,
      });
    },
  );

  it.each(["skip", "restart"])("does not turn %s into an implicit reinstall", async (action) => {
    gatewayServiceIsLoaded.mockResolvedValueOnce(true).mockResolvedValue(false);
    const prompter = buildWizardPrompter(undefined, { defaultSelect: action });

    const result = await ensureGatewayServiceForOnboarding(
      createFinalizeArgs("quickstart", { opts: { installDaemon: true }, prompter }),
    );

    expect(result.gateway).toEqual({
      status: "ready",
      action: action === "restart" ? "restarted" : "reused",
    });
    expect(readPin).not.toHaveBeenCalled();
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    expect(gatewayServiceRestart).toHaveBeenCalledTimes(action === "restart" ? 1 : 0);
  });

  it("reports selected providers blocked by plugin policy as unavailable", async () => {
    const prompter = createLaterPrompter();

    await finalize("advanced", {
      nextConfig: createSearchConfig(),
      prompter,
    });

    expectNoteContains(
      prompter,
      "selected but unavailable under the current plugin policy",
      "Web search",
    );
    expect(resolveExistingKey).not.toHaveBeenCalled();
    expect(hasExistingKey).not.toHaveBeenCalled();
  });

  it("only reports legacy auto-detect for runtime-visible providers", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "perplexity",
        label: "Perplexity Search",
        envVars: ["PERPLEXITY_API_KEY"],
      }),
    ]);
    hasExistingKey.mockImplementation((configForTest, provider) => provider === "perplexity");

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(createFinalizeArgs("advanced", { prompter }));

    expectNoteContains(
      prompter,
      "Web search is available via Perplexity Search (auto-detected).",
      "Web search",
    );
  });

  it("uses configured provider resolution instead of the active runtime registry", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "firecrawl",
        label: "Firecrawl Search",
        envVars: ["FIRECRAWL_API_KEY"],
      }),
    ]);
    hasExistingKey.mockImplementation((configForTest, provider) => provider === "firecrawl");

    const prompter = createLaterPrompter();

    await finalize("advanced", {
      nextConfig: createSearchConfig(),
      prompter,
    });

    expectNoteContains(
      prompter,
      "Web search is enabled, so your agent can look things up online when needed.",
      "Web search",
    );
  });

  it("reports OAuth-backed web search as enabled without an API key", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "grok",
        label: "Grok (xAI)",
        envVars: ["XAI_API_KEY"],
        authProviderId: "xai",
      }),
    ]);
    hasAuthProfileForProvider.mockImplementation(
      ({ provider, type }) => provider === "xai" && (!type || type === "oauth"),
    );

    const prompter = createLaterPrompter();

    await finalize("advanced", {
      nextConfig: createSearchConfig("grok"),
      prompter,
    });

    expectNoteContains(
      prompter,
      "Web search is enabled, so your agent can look things up online when needed.",
      "Web search",
    );
    expectNoteContains(prompter, "Credential: existing xAI OAuth sign-in.", "Web search");
    expect(
      vi
        .mocked(prompter.note)
        .mock.calls.some(
          ([message, title]) => title === "Web search" && message.includes("no API key"),
        ),
    ).toBe(false);
    expect(hasAuthProfileForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
      }),
    );
    expect(hasAuthProfileForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        type: "oauth",
      }),
    );
  });

  it("reports a keyless provider as ready without prompting for an API key", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        id: "parallel-free",
        label: "Parallel Search (Free)",
        envVars: [],
        requiresCredential: false,
      }),
    ]);

    const prompter = createLaterPrompter();

    await finalize("advanced", {
      nextConfig: createSearchConfig("parallel-free"),
      prompter,
    });

    expectNoteContains(
      prompter,
      "Web search is ready — this provider works with no API key.",
      "Web search",
    );
    // The credential-required warning must NOT appear for a keyless provider.
    expect(
      vi
        .mocked(prompter.note)
        .mock.calls.some(
          ([message, title]) =>
            title === "Web search" &&
            (message.includes("no API key was found") ||
              message.includes("will not work until a key is added")),
        ),
    ).toBe(false);
  });

  it("uses the setup token for health checks to avoid local env token drift", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");
    const prompter = createLaterPrompter();

    await finalize("quickstart", {
      opts: { skipHealth: false, skipUi: true },
      settings: { gatewayToken: "session-token" },
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: "config-token",
          },
        },
      },
      prompter,
    });

    expect(requireMockArg(healthCommand)).toMatchObject({
      json: false,
      timeoutMs: 10_000,
      token: "session-token",
      config: { gateway: { auth: { mode: "token", token: "session-token" } } },
    });
    expect(requireMockArg(healthCommand, 0, 1)).toBeTypeOf("object");
  });

  it("ends with a health-failure outro when the health check exits after a reachable probe", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    // importActual yields the ExitError instance the prod graph sees; the test
    // file's static import can be a second class instance under Vitest.
    const { ExitError } = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
    healthCommand.mockRejectedValueOnce(new ExitError(1));
    const prompter = createLaterPrompter();

    await finalize("quickstart", {
      opts: { skipHealth: false, skipUi: true },
      settings: { gatewayToken: "session-token" },
      prompter,
    });

    expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
  });

  it.each(["return", "reject"] as const)(
    "joins the temporary Gateway after TUI %s in containers without systemd",
    async (outcome) => {
      await withPlatform("linux", async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        waitForGatewayReachable.mockResolvedValue({ ok: true });
        probeGatewayReachable.mockResolvedValue({ ok: true });
        const closeStarted = createDeferred();
        const allowClose = createDeferred();
        const sessionGateway = {
          close: vi.fn(async () => {
            closeStarted.resolve();
            await allowClose.promise;
          }),
        };
        const tuiFailure = new Error("TUI failed");
        if (outcome === "reject") {
          runTui.mockRejectedValueOnce(tuiFailure);
        }
        startGatewayServer.mockResolvedValueOnce(sessionGateway);
        const prompter = createLaterPrompter();

        const finalizing = finalizeSetupWizard(
          createFinalizeArgs("quickstart", {
            opts: { installDaemon: undefined, skipHealth: false },
            settings: { gatewayToken: "test-token" },
            nextConfig: {
              gateway: {
                auth: {
                  mode: "token",
                  token: "test-token",
                },
              },
            },
            prompter,
          }),
        );

        let finalized = false;
        const settled = finalizing.then(
          () => {
            finalized = true;
          },
          () => {
            finalized = true;
          },
        );
        try {
          await awaitGateBeforeSettlement(
            closeStarted.promise,
            finalizing,
            "wizard returned before closing its temporary Gateway",
          );
          expect(finalized).toBe(false);
        } finally {
          allowClose.resolve();
          await settled;
        }
        if (outcome === "reject") {
          await expect(finalizing).rejects.toBe(tuiFailure);
        } else {
          await expect(finalizing).resolves.toEqual({ launchedTui: true });
        }

        expect(startGatewayServer).toHaveBeenCalledWith(
          18789,
          expect.objectContaining({
            bind: "loopback",
            auth: expect.objectContaining({
              mode: "token",
              token: "test-token",
            }),
          }),
        );
        expect(runTui).toHaveBeenCalledWith(
          expect.objectContaining({
            boundGateway: {
              url: "ws://127.0.0.1:18789",
              token: "test-token",
            },
            deliver: false,
            message: undefined,
            initialMessageTimeoutMs: 300_000,
          }),
        );
        expect(runTui.mock.calls.at(-1)?.[0]).not.toHaveProperty("timeoutMs");
        expect(sessionGateway.close).toHaveBeenCalledWith({ reason: "onboarding tui exited" });
        expect(sessionGateway.close).toHaveBeenCalledOnce();
        expectNoteContains(
          prompter,
          "Systemd user services are not available inside this container.",
          "Container runtime",
        );
        expectNoteTitleNotCalled(prompter, "Systemd");
        expect(gatewayServiceInstall).not.toHaveBeenCalled();
      });
    },
  );

  it("closes a session gateway when finalize fails before TUI launch", async () => {
    await withPlatform("linux", async () => {
      isSystemdUserServiceAvailable.mockResolvedValue(false);
      isContainerEnvironment.mockReturnValue(true);
      waitForGatewayReachable.mockRejectedValueOnce(new Error("probe failed"));
      const sessionGateway = { close: vi.fn(async () => {}) };
      startGatewayServer.mockResolvedValueOnce(sessionGateway);
      const prompter = createLaterPrompter();

      await expect(
        finalizeSetupWizard(
          createFinalizeArgs("quickstart", {
            opts: { installDaemon: undefined, skipHealth: false },
            settings: { gatewayToken: "test-token" },
            nextConfig: {
              gateway: {
                auth: {
                  mode: "token",
                  token: "test-token",
                },
              },
            },
            prompter,
          }),
        ),
      ).rejects.toThrow("probe failed");

      expect(runTui).not.toHaveBeenCalled();
      expect(sessionGateway.close).toHaveBeenCalledWith({ reason: "onboarding finalize exited" });
    });
  });

  it("uses the resolved setup password for health checks", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "env-password");
    resolveSetupSecretInputString.mockResolvedValueOnce("session-password");
    const prompter = createLaterPrompter();

    await finalize("quickstart", {
      opts: { skipHealth: false, skipUi: true },
      settings: { authMode: "password" },
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
      },
      prompter,
    });

    expect(requireMockArg(probeGatewayReachable)).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: undefined,
      password: "session-password",
    });
    expect(requireMockArg(healthCommand)).toMatchObject({
      json: false,
      timeoutMs: 10_000,
      token: undefined,
      password: "session-password",
      config: { gateway: { auth: { mode: "password" } } },
    });
    expect(requireMockArg(healthCommand, 0, 1)).toBeTypeOf("object");
  });

  it("shows actionable gateway guidance instead of a hard error in no-daemon onboarding", async () => {
    await withPlatform("linux", async () => {
      waitForGatewayReachable.mockResolvedValue({
        ok: false,
        detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
      });
      probeGatewayReachable.mockResolvedValue({
        ok: false,
        detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
      });
      const prompter = createLaterPrompter();
      const runtime = createRuntime();

      await finalizeSetupWizard(
        createFinalizeArgs("quickstart", {
          opts: { skipHealth: false },
          settings: { gatewayToken: "test-token" },
          prompter,
          runtime,
        }),
      );

      expect(runtime.error).not.toHaveBeenCalledWith("health failed");
      expectNoteContains(prompter, "Setup was run without Gateway service install", "Gateway");
      expectNoteTitleNotCalled(prompter, "Dashboard ready");
      expect(prompter.outro).toHaveBeenCalledWith(
        "Gateway not detected yet. Start now: openclaw gateway run",
      );
      expect(readSystemdUserLingerStatus).not.toHaveBeenCalled();
      expect(gatewayServiceIsLoaded).not.toHaveBeenCalled();
      expect(gatewayServiceInstall).not.toHaveBeenCalled();
      expect(gatewayServiceRestart).not.toHaveBeenCalled();
      expect(startGatewayService).not.toHaveBeenCalled();
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.select).not.toHaveBeenCalled();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
