// Setup finalize tests cover writing final onboarding config and artifacts.
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { PreparedModelCatalogConfigReplacedError } from "../agents/prepared-model-catalog.errors.js";
import type * as AuthChoiceModelCheck from "../commands/auth-choice.model-check.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import {
  createFinalizeArgs as baseFinalizeArgs,
  createLaterPrompter,
  createRuntime,
  sessionGatewayTuiCases,
  sessionGatewayTuiTarget,
  type FinalizeArgs,
  type FinalizeArgsOverrides,
  createGatewayPasswordRefConfig,
} from "./setup.finalize.fixtures.test-support.js";
import { readPin } from "./setup.finalize.runtime-pin.test-support.js";
import {
  createRuntimeProbeResult,
  expectNoteContains as expectWizardNoteContains,
  expectNoteTitleNotCalled as expectWizardNoteTitleNotCalled,
  withPlatform,
  expectNoteNotContains as expectWizardNoteNotContains,
} from "./setup.finalize.test-support.js";

type DefaultModelAuthStatus = Awaited<
  ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>
>;

const runExec = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec,
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

const healthCommand = vi.hoisted(() => vi.fn(async () => {}));
const resolveDefaultModelAuthStatus = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>
    ) => DefaultModelAuthStatus
  >(),
);
const resolveDefaultModelCatalogFacts = vi.hoisted(() =>
  vi.fn((): ReturnType<typeof AuthChoiceModelCheck.resolveDefaultModelCatalogFacts> => ({})),
);
const makeInstallPlan = vi.hoisted(() => () => ({
  runtime: "node" as const,
  programArguments: [],
  workingDirectory: "/tmp",
  environment: {},
  environmentValueSources: {},
}));
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn<typeof import("../commands/daemon-install-helpers.js").buildGatewayInstallPlan>(async () =>
    makeInstallPlan(),
  ),
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

// mock-isolation: Finalization controls readiness outcomes without probing live provider accounts.
vi.mock("../commands/auth-choice.model-check.js", () => ({
  resolveDefaultModelCatalogFacts,
  resolveDefaultModelAuthStatus: async (
    ...args: Parameters<typeof AuthChoiceModelCheck.resolveDefaultModelAuthStatus>
  ) => resolveDefaultModelAuthStatus(...args),
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

let prompter: FinalizeArgs["prompter"];
let runtime: FinalizeArgs["runtime"];

function createFinalizeArgs(flow: FinalizeArgs["flow"], overrides: FinalizeArgsOverrides = {}) {
  return baseFinalizeArgs(flow, { prompter, runtime, ...overrides });
}

function setupService(
  overrides: Partial<Parameters<typeof ensureGatewayServiceForOnboarding>[0]> = {},
) {
  return ensureGatewayServiceForOnboarding({
    flow: "quickstart",
    opts: {},
    nextConfig: {},
    settings: { port: 18789 },
    prompter,
    runtime,
    ...overrides,
  });
}

function createSearchConfig(provider = "firecrawl"): OpenClawConfig {
  return { tools: { web: { search: { provider, enabled: true } } } };
}

function finalize(flow: FinalizeArgs["flow"], overrides: FinalizeArgsOverrides = {}) {
  return finalizeSetupWizard(createFinalizeArgs(flow, overrides));
}

function expectNoteContains(expected: string, title = "Gateway") {
  expectWizardNoteContains(prompter, expected, title);
}
function expectNoteNotContains(...unexpected: string[]) {
  for (const message of unexpected) {
    expectWizardNoteNotContains(prompter, message);
  }
}
function expectNoteTitleNotCalled(title: string) {
  expectWizardNoteTitleNotCalled(prompter, title);
}

function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectCall(mock: unknown, fields: object) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

describe("finalizeSetupWizard", () => {
  beforeEach(() => {
    prompter = createLaterPrompter();
    runtime = createRuntime();
    readPin.mockReset().mockReturnValue({ revision: "empty", stored: false });
    runExec.mockReset().mockResolvedValue(createRuntimeProbeResult());
    resetFinalizeMocks();
    healthCommand.mockReset().mockResolvedValue(undefined);
    buildGatewayInstallPlan.mockClear();
    resolveDefaultModelAuthStatus.mockReset().mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-8",
      status: "ready",
    });
    resolveDefaultModelCatalogFacts.mockReset().mockReturnValue({});
  });

  it("waits for the served dashboard before announcing its URL", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    const stop = vi.fn();
    prompter = buildWizardPrompter({
      progress: vi.fn(() => ({ update: vi.fn(), stop })),
    });
    let resolveDocument: ((value: { ready: true }) => void) | undefined;
    waitForControlUiDocument.mockImplementation(async ({ onPending }) => {
      onPending?.();
      return await new Promise<{ ready: true }>((resolve) => {
        resolveDocument = resolve;
      });
    });

    const finalizing = finalize("quickstart", {});
    await vi.waitFor(() => expect(waitForControlUiDocument).toHaveBeenCalledOnce());
    expectNoteTitleNotCalled("Control UI");
    expect(prompter.outro).not.toHaveBeenCalled();
    expect(prompter.progress).toHaveBeenCalledWith("Preparing the Control UI…");

    resolveDocument?.({ ready: true });
    await finalizing;

    expect(stop).toHaveBeenCalledOnce();
    expectNoteContains("Web UI: http://127.0.0.1:18789", "Control UI");
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
    const args = createFinalizeArgs("quickstart", {});
    const gatewayToken = ["classic", "token"].join("-");

    await finalizeSetupWizard({
      ...args,
      settings: { ...args.settings, gatewayToken },
    });

    expect(args.runtime.error).toHaveBeenCalledWith("Control UI build failed: missing startup.js");
    expectNoteContains("Gateway: reachable", "Control UI");
    expectNoteNotContains("Web UI:");
    expectNoteNotContains(gatewayToken);
    expect(prompter.outro).toHaveBeenCalledWith(
      "OpenClaw is ready. When you're ready: openclaw dashboard",
    );
    expectCall(runTui, {
      config: args.nextConfig,
      boundGateway: {
        url: "ws://127.0.0.1:18789",
        token: gatewayToken,
      },
    });
    const tuiOptions = runTui.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(tuiOptions).not.toHaveProperty("url");
    expect(tuiOptions).not.toHaveProperty("token");
    expect(tuiOptions).toMatchObject({ initialMessageTimeoutMs: 300_000 });
    expect(tuiOptions).not.toHaveProperty("timeoutMs");
  });

  it("does not wait for dashboard assets when the UI is disabled", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });

    await finalize("quickstart", {
      nextConfig: { gateway: { controlUi: { enabled: false } } },
      settings: { gatewayToken: "offline-token" },
    });

    expectUncalled(resolveControlUiHandoffTarget, waitForControlUiDocument);
    expectNoteNotContains("Web UI:");
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
      gateway: { port: 18789, bind: "loopback", tls: tlsConfig },
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

    expectCall(resolveControlUiHandoffTarget, {
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
    });
    expectCall(waitForControlUiDocument, {
      url: "https://127.0.0.1:19876/dashboard/",
      tlsConfig,
    });
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
    await finalize("advanced", {
      opts: { skipHealth: false, skipUi: false },
      nextConfig: { gateway: { bind: "lan" } },
      settings: { bind: "lan" },
    });

    expectCall(resolveAdvertisedControlUiLinks, { bind: "lan", port: 18789 });
    expectCall(probeGatewayReachable, { url: "ws://127.0.0.1:18789" });
    expectNoteContains("http://10.211.55.3:18789/", "Control UI");
    expectNoteContains("ws://10.211.55.3:18789", "Control UI");
    expectNoteContains(
      "Windows firewall: if another device cannot connect to the LAN URL",
      "Control UI",
    );
  });

  it.each(["first", "rerun", "missing", "incompatible", "replaced", "failed"] as const)(
    "handles the %s catalog/auth state before hatching",
    async (reason) => {
      vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
      const catalog = [{ id: "gpt-5.4-nano", name: "GPT 5.4 Nano", provider: "openai" }];
      const observedRoutes = [
        {
          api: "openai-chatgpt-responses" as const,
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
      ];
      const nextConfig: OpenClawConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.4-nano" },
          entries: { main: { agentDir: "/tmp/custom-agent" } },
        },
      };
      const error =
        reason === "replaced"
          ? new PreparedModelCatalogConfigReplacedError("/tmp/replaced-agent")
          : new Error("catalog read failed");
      if (reason === "replaced" || reason === "failed") {
        loadModelCatalog.mockRejectedValueOnce(error);
      } else {
        loadModelCatalog.mockResolvedValueOnce(catalog);
        resolveDefaultModelCatalogFacts.mockReturnValueOnce({ observedRoutes });
      }
      if (reason === "missing" || reason === "incompatible") {
        resolveDefaultModelAuthStatus.mockReturnValueOnce({
          provider: "openai",
          model: reason === "missing" ? "gpt-5.5" : "gpt-5.6",
          status: reason,
          ...(reason === "incompatible"
            ? { message: "gpt-5.6 requires OpenAI Platform API-key authentication." }
            : {}),
        });
      }
      const result = finalize("quickstart", { nextConfig, hadExistingConfig: reason === "rerun" });
      if (reason === "failed") {
        await expect(result).rejects.toBe(error);
        expect(runTui).not.toHaveBeenCalled();
        return;
      }
      await expect(result).resolves.toEqual({ launchedTui: true });
      expect(runTui).toHaveBeenCalledWith({
        local: true,
        deliver: false,
        message: reason === "first" ? "Wake up, my friend!" : undefined,
        initialMessageTimeoutMs: 300_000,
      });
      if (reason === "replaced") {
        expectUncalled(resolveDefaultModelCatalogFacts, resolveDefaultModelAuthStatus);
      } else if (reason === "first") {
        expect(loadModelCatalog).toHaveBeenCalledWith({ config: nextConfig, readOnly: true });
        expect(resolveDefaultModelCatalogFacts).toHaveBeenCalledWith(nextConfig, catalog, {
          routeVariants: catalog,
        });
        expect(resolveDefaultModelAuthStatus).toHaveBeenCalledWith(nextConfig, {
          agentDir: "/tmp/custom-agent",
          observedRoutes,
        });
      } else if (reason === "missing") {
        expectNoteContains(
          'No credentials are configured for provider "openai"',
          "Model auth missing",
        );
      } else if (reason === "incompatible") {
        expectNoteTitleNotCalled("Model auth missing");
        expectNoteNotContains(
          "No credentials are configured",
          "openclaw configure --section model",
        );
      }
    },
  );

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const token = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } as const;
    buildGatewayInstallPlan.mockResolvedValueOnce({
      ...makeInstallPlan(),
      environment: { DISCORD_BOT_TOKEN: "discord-test-token" },
      environmentValueSources: { DISCORD_BOT_TOKEN: "file" },
    });

    await finalize("advanced", {
      opts: { installDaemon: true },
      settings: { gatewayToken: "session-token" },
      nextConfig: { gateway: { auth: { mode: "token", token } } },
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expectCall(gatewayServiceInstall, {
      environmentValueSources: { DISCORD_BOT_TOKEN: "file" },
    });
  });

  it("reports the installed Bun runtime for QuickStart", async () => {
    buildGatewayInstallPlan.mockResolvedValueOnce({
      ...makeInstallPlan(),
      runtime: "bun",
      programArguments: [process.execPath, "/app/openclaw.mjs", "gateway"],
    });
    const result = await setupService({ opts: { installDaemon: true } });
    expect(result.gateway).toEqual({ status: "ready", action: "installed" });
    expectNoteContains("QuickStart uses Bun", "Gateway service runtime");
    expectNoteNotContains("QuickStart uses Node");
    expect(gatewayServiceInstall).toHaveBeenCalledOnce();
  });

  it("waits for gateway install warnings before installing the service", async () => {
    const warningAcknowledged = createDeferred();
    prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
      note: vi.fn(async (message: string) => {
        if (message === "Gateway install warning") {
          await warningAcknowledged.promise;
        }
      }),
    });
    buildGatewayInstallPlan.mockImplementationOnce(async (params) => {
      params?.warn?.("Gateway install warning", "Gateway service");
      return makeInstallPlan();
    });

    const finalizePromise = finalize("advanced", { opts: { installDaemon: true } });
    await vi.waitFor(() => {
      expect(prompter.note).toHaveBeenCalledWith("Gateway install warning", "Gateway service");
    });
    expect(gatewayServiceInstall).not.toHaveBeenCalled();

    warningAcknowledged.resolve();
    await finalizePromise;

    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  it("shows gateway install warnings when planning fails", async () => {
    buildGatewayInstallPlan.mockImplementationOnce(async (params) => {
      params?.warn?.("Gateway install warning", "Gateway service");
      throw new Error("plan failed");
    });

    await finalize("advanced", { opts: { installDaemon: true } });

    expect(prompter.note).toHaveBeenCalledWith("Gateway install warning", "Gateway service");
    expectNoteContains("plan failed");
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
        prompter = buildWizardPrompter(undefined, { defaultSelect: choice });

        await finalize("quickstart", {
          opts: { installDaemon: action !== "skipped", skipHealth: false, skipUi: true },
        });

        if (action === "skipped") {
          expect(waitForGatewayReachable).not.toHaveBeenCalled();
          expectNoteContains("openclaw gateway run");
          expect(prompter.outro).toHaveBeenCalledWith(
            expect.stringContaining("openclaw gateway run"),
          );
          return;
        }
        const managedStartup = action !== "reused";
        const startupTiming = resolveGatewayStartupTiming(platform);
        expect(waitForGatewayReachable).toHaveBeenCalledOnce();
        const timing = mockCall(waitForGatewayReachable)[0] as {
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
      prompter = buildWizardPrompter({
        select: vi.fn().mockResolvedValueOnce("reinstall").mockResolvedValueOnce("tui"),
      });

      await finalize("quickstart", {
        opts: { installDaemon: true, skipHealth },
      });

      expectUncalled(gatewayServiceUninstall, gatewayServiceInstall, waitForGatewayReachable);
      expect(probeGatewayReachable).toHaveBeenCalledOnce();
      expect(healthCommand).toHaveBeenCalledTimes(skipHealth ? 0 : 1);
      expectCall(runTui, { boundGateway: { url: "ws://127.0.0.1:18789" } });
      expectNoteContains("replacement plan failed");
      expectNoteNotContains("Gateway: not detected");
      expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("setup failed"));
    },
  );

  it.each(["install", "restart"] as const)(
    "reports gateway %s failure with recovery guidance instead of success",
    async (action) => {
      gatewayServiceIsLoaded.mockResolvedValue(action === "restart");
      const error = `service ${action} exploded`;
      (action === "restart" ? gatewayServiceRestart : gatewayServiceInstall).mockRejectedValueOnce(
        new Error(error),
      );
      const progressStop = vi.fn();
      prompter = buildWizardPrompter(
        {
          progress: () => ({ update: vi.fn(), stop: progressStop }),
        },
        { defaultSelect: "restart" },
      );
      await finalize("advanced", {
        opts: { installDaemon: true, skipHealth: false },
      });

      expect(progressStop).not.toHaveBeenCalledWith("Gateway service restarted.");
      expect(progressStop).not.toHaveBeenCalledWith("Gateway service installed.");
      expect(waitForGatewayReachable).not.toHaveBeenCalled();
      expect(probeGatewayReachable).toHaveBeenCalledOnce();
      expect(runtime.error).toHaveBeenCalledWith("health failed");
      expectNoteContains(error);
      expectNoteContains("Gateway: not detected (offline)", "Control UI");
      expect(prompter.outro).toHaveBeenCalledWith(
        expect.stringContaining("managed Mock Platform Service setup failed"),
      );
      expectNoteContains("openclaw gateway status --deep");
      expectNoteContains("openclaw gateway install --force");
      expectNoteNotContains("openclaw gateway run");
      expectNoteNotContains("openclaw gateway restart");
    },
  );

  it("keeps managed readiness timeout recovery on the canonical service path", async () => {
    const detail = "gateway readiness timed out";
    waitForGatewayReachable.mockResolvedValue({ ok: false, detail });
    probeGatewayReachable.mockResolvedValue({ ok: false, detail });
    await finalize("advanced", {
      opts: { installDaemon: true, skipHealth: false },
    });

    expectNoteContains("managed Mock Platform Service");
    expectNoteContains("openclaw gateway status --deep");
    expectNoteContains("openclaw gateway restart");
    expectNoteNotContains("openclaw gateway run");
    expectNoteNotContains("openclaw onboard --install-daemon");
    expectNoteNotContains("openclaw gateway install --force");
  });

  it("preserves external supervision through unreachable container recovery", async () => {
    await withPlatform("linux", async () => {
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        const offline = { ok: false, detail: "external gateway is offline" };
        waitForGatewayReachable.mockResolvedValue(offline);
        probeGatewayReachable.mockResolvedValue(offline);
        await finalize("advanced", {
          opts: { skipHealth: false, skipUi: false },
        });

        expectUncalled(
          isSystemdUserServiceAvailable,
          isContainerEnvironment,
          startOnboardingGatewayProcess,
        );
        expectNoteContains("Use that supervisor to start the gateway.");
        expectNoteNotContains("openclaw gateway run");
        expectNoteNotContains("openclaw onboard --install-daemon");
        expect(prompter.outro).toHaveBeenCalledWith(
          "Gateway not detected yet. OpenClaw gateway lifecycle is managed by an external " +
            "supervisor (OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to start the " +
            "gateway.",
        );
      });
    });
  });

  it.each([
    ["missing-install", "installed"],
    ["already-running", "reused"],
    ["started", "started"],
    ["repair-required", "failed"],
  ] as const)("resumes a %s gateway as %s without restarting", async (outcome, action) => {
    const installed = outcome !== "missing-install";
    const repair = "service is configured for another port";
    startGatewayService.mockResolvedValueOnce({
      outcome,
      state: {
        installed,
        loaded: installed,
        running: outcome === "started" || outcome === "already-running",
        env: process.env,
        command: installed ? { programArguments: ["openclaw", "gateway"] } : null,
      },
      issues: outcome === "repair-required" ? [{ message: repair }] : [],
    });
    const result = await setupService({ loadedAction: "resume" });
    expect(result.gateway).toEqual(
      action === "failed" ? { status: "failed", error: repair } : { status: "ready", action },
    );
    expect(startGatewayService).toHaveBeenCalledOnce();
    expect(gatewayServiceInstall).toHaveBeenCalledTimes(installed ? 0 : 1);
    expect(gatewayServiceRestart).not.toHaveBeenCalled();
    if (action === "failed") {
      expectNoteNotContains(repair);
    }
  });

  it("never prints the reusable Gateway token during classic onboarding", async () => {
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    runtime = { log: runtimeLog, error: runtimeError, exit: vi.fn() };
    probeGatewayReachable.mockResolvedValue({ ok: true });

    await finalize("advanced", {
      opts: { skipUi: false },
      settings: { gatewayToken: "session-token" },
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
    prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service already installed") {
          return "restart";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: progressUpdate, stop: progressStop })),
    });

    await finalize("advanced", { opts: { installDaemon: true } });

    expect(gatewayServiceRestart).toHaveBeenCalledTimes(1);
    expectUncalled(gatewayServiceInstall, gatewayServiceUninstall);
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
    prompter = buildWizardPrompter(undefined, { defaultSelect: "reinstall" });

    const result = await setupService({ opts: { installDaemon: true } });

    expect(result.gateway.status).toBe("failed");
    expect(installed).toBe(true);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
  });

  it.each([undefined, "node"] as const)(
    "passes installed pin intent to the reinstall owner (explicit=%s)",
    async (daemonRuntime) => {
      const pin = { runtime: "bun", path: "/opt/pinned/bun" } as const;
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
      const existingCommand = {
        programArguments: ["/operator/drop-in-wrapper", "gateway"],
      };
      gatewayServiceReadCommand.mockResolvedValue(existingCommand);
      prompter = buildWizardPrompter(undefined, { defaultSelect: "reinstall" });

      const result = await setupService({
        opts: { installDaemon: true, daemonRuntime },
      });

      expect(result.gateway).toEqual({ status: "ready", action: "installed" });
      expectCall(buildGatewayInstallPlan, {
        existingCommand,
      });
      expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("existingEnvironment");
      expect(gatewayServiceInstall).toHaveBeenCalledOnce();
      expectCall(gatewayServiceInstall, {
        runtimePinUpdate: { expected, pin: daemonRuntime ? undefined : pin },
      });
      expectCall(buildGatewayInstallPlan, {
        runtime: daemonRuntime ?? "bun",
        pinnedRuntimePath: daemonRuntime ? undefined : pin.path,
      });
      expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    },
  );

  it.each([
    { flow: "advanced", choice: "node" },
    { flow: "quickstart", choice: "bun" },
  ] as const)(
    "reinstalls recorded Bun through $flow with choice=$choice",
    async ({ flow, choice }) => {
      const recordedPath = "/opt/recorded/bin/bun";
      runExec.mockResolvedValue(createRuntimeProbeResult("1.4.4"));
      gatewayServiceIsLoaded.mockResolvedValue(true);
      gatewayServiceReadCommand.mockResolvedValue({
        programArguments: [recordedPath, "/app/openclaw.mjs", "gateway"],
      });
      prompter = buildWizardPrompter();
      const selectRuntime = vi
        .mocked(prompter.select)
        .mockResolvedValueOnce("reinstall")
        .mockResolvedValueOnce(choice);

      const result = await setupService({
        flow,
        opts: { installDaemon: true },
      });

      expect(result.gateway).toEqual({ status: "ready", action: "installed" });
      if (flow === "advanced") {
        expectCall(selectRuntime, { initialValue: "bun" });
      }
      expect(selectRuntime).toHaveBeenCalledTimes(flow === "advanced" ? 2 : 1);
      expect(mockCall(buildGatewayInstallPlan)[0]).toMatchObject({
        runtime: choice,
        runtimePath: choice === "bun" ? recordedPath : undefined,
        pinnedRuntimePath: undefined,
      });
    },
  );

  it.each(["skip", "restart"])("does not turn %s into an implicit reinstall", async (action) => {
    gatewayServiceIsLoaded.mockResolvedValueOnce(true).mockResolvedValue(false);
    prompter = buildWizardPrompter(undefined, { defaultSelect: action });

    const result = await setupService({ opts: { installDaemon: true } });

    expect(result.gateway).toEqual({
      status: "ready",
      action: action === "restart" ? "restarted" : "reused",
    });
    expectUncalled(readPin, gatewayServiceInstall, gatewayServiceUninstall);
    expect(gatewayServiceRestart).toHaveBeenCalledTimes(action === "restart" ? 1 : 0);
  });

  it.each([
    ["firecrawl", "Firecrawl Search", "unavailable"],
    ["perplexity", "Perplexity Search", "legacy"],
    ["firecrawl", "Firecrawl Search", "key"],
    ["grok", "Grok (xAI)", "oauth"],
    ["parallel-free", "Parallel Search (Free)", "keyless"],
  ] as const)("reports %s web search with %s (%s)", async (id, label, mode) => {
    if (mode !== "unavailable") {
      listConfiguredWebSearchProviders.mockReturnValue([
        createWebSearchProviderEntry({
          id,
          label,
          envVars:
            mode === "keyless"
              ? []
              : [mode === "oauth" ? "XAI_API_KEY" : `${id.toUpperCase()}_API_KEY`],
          ...(mode === "oauth" ? { authProviderId: "xai" } : {}),
          ...(mode === "keyless" ? { requiresCredential: false } : {}),
        }),
      ]);
    }
    if (mode === "key" || mode === "legacy") {
      hasExistingKey.mockImplementation((_config, provider) => provider === id);
    }
    if (mode === "oauth") {
      hasAuthProfileForProvider.mockImplementation(
        ({ provider, type }) => provider === "xai" && (!type || type === "oauth"),
      );
    }
    await finalize("advanced", {
      nextConfig: mode === "legacy" ? {} : createSearchConfig(id),
    });

    if (mode === "unavailable") {
      expectNoteContains("selected but unavailable under the current plugin policy", "Web search");
      expectUncalled(resolveExistingKey, hasExistingKey);
    } else if (mode === "legacy") {
      expectNoteContains(
        "Web search is available via Perplexity Search (auto-detected).",
        "Web search",
      );
    } else if (mode === "keyless") {
      expectNoteContains(
        "Web search is ready — this provider works with no API key.",
        "Web search",
      );
      expectNoteNotContains("no API key was found");
      expectNoteNotContains("will not work until a key is added");
    } else {
      expectNoteContains(
        "Web search is enabled, so your agent can look things up online when needed.",
        "Web search",
      );
      if (mode === "oauth") {
        expectNoteContains("Credential: existing xAI OAuth sign-in.", "Web search");
        expectNoteNotContains("no API key");
        expectCall(hasAuthProfileForProvider, { provider: "xai", type: "oauth" });
      }
    }
  });

  it.each(["token", "password"] as const)(
    "uses setup %s auth for health checks despite ambient credentials",
    async (authMode) => {
      probeGatewayReachable.mockResolvedValue({ ok: true });
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "env-password");
      resolveSetupSecretInputString.mockResolvedValueOnce("session-password");
      const passwordMode = authMode === "password";
      await finalize("quickstart", {
        opts: { skipHealth: false, skipUi: true },
        settings: { authMode, ...(passwordMode ? {} : { gatewayToken: "session-token" }) },
        nextConfig: passwordMode
          ? createGatewayPasswordRefConfig()
          : { gateway: { auth: { mode: "token", token: "config-token" } } },
      });
      const auth = passwordMode
        ? { token: undefined, password: "session-password" }
        : { token: "session-token" };
      expect(mockCall(healthCommand)[0]).toMatchObject({
        json: false,
        timeoutMs: 10_000,
        ...auth,
        config: {
          gateway: {
            auth: { mode: authMode, ...(passwordMode ? {} : { token: "session-token" }) },
          },
        },
      });
      if (passwordMode) {
        expect(mockCall(probeGatewayReachable)[0]).toMatchObject({
          url: "ws://127.0.0.1:18789",
          ...auth,
        });
      }
    },
  );

  it("ends with a health-failure outro when the health check exits after a reachable probe", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: true });
    // importActual yields the ExitError instance the prod graph sees; the test
    // file's static import can be a second class instance under Vitest.
    const { ExitError } = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
    healthCommand.mockRejectedValueOnce(new ExitError(1));

    await finalize("quickstart", {
      opts: { skipHealth: false, skipUi: true },
      settings: { gatewayToken: "session-token" },
    });

    expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
  });

  it.each(sessionGatewayTuiCases)(
    "joins the temporary Gateway around TUI %s (skipHealth=%s, ready=%s)",
    async (outcome, skipHealth, gatewayReady) => {
      await withPlatform("linux", async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        const probeStarted = createDeferred();
        const reachable = createDeferred<{ ok: boolean }>();
        waitForGatewayReachable.mockImplementationOnce(() => {
          probeStarted.resolve();
          return reachable.promise;
        });
        const closeStarted = createDeferred();
        const allowClose = createDeferred();
        const sessionGateway = {
          wait: new Promise<void>(() => {}),
          close: vi.fn(async () => {
            closeStarted.resolve();
            await allowClose.promise;
          }),
        };
        const tuiFailure = new Error("TUI failed");
        if (outcome === "reject") {
          runTui.mockRejectedValueOnce(tuiFailure);
        }
        startOnboardingGatewayProcess.mockResolvedValueOnce(sessionGateway);

        const finalizing = finalize("quickstart", {
          opts: { installDaemon: undefined, skipHealth },
          settings: { gatewayToken: "test-token" },
        });
        await awaitGateBeforeSettlement(
          probeStarted.promise,
          closeStarted.promise,
          "wizard launched the TUI before waiting for its temporary Gateway",
        );
        expect(runTui).not.toHaveBeenCalled();
        reachable.resolve({ ok: gatewayReady });

        let finalized = false;
        const markFinalized = () => {
          finalized = true;
        };
        const settled = finalizing.then(markFinalized, markFinalized);
        try {
          await awaitGateBeforeSettlement(
            closeStarted.promise,
            finalizing,
            "wizard returned before closing its temporary Gateway",
          );
          expect(finalized).toBe(false);
          if (!gatewayReady) {
            expect(runTui).not.toHaveBeenCalled();
          }
        } finally {
          allowClose.resolve();
          await settled;
        }
        if (outcome === "reject") {
          await expect(finalizing).rejects.toBe(tuiFailure);
        } else {
          await expect(finalizing).resolves.toEqual({ launchedTui: true });
        }

        expect(startOnboardingGatewayProcess).toHaveBeenCalledOnce();
        expectCall(runTui, {
          ...(gatewayReady ? sessionGatewayTuiTarget : { local: true }),
          deliver: false,
          message: undefined,
          initialMessageTimeoutMs: 300_000,
        });
        expect(runTui.mock.calls.at(-1)?.[0]).not.toHaveProperty("timeoutMs");
        if (!gatewayReady) {
          expect(runTui.mock.calls.at(-1)?.[0]).not.toHaveProperty("boundGateway");
          expect(runTui.mock.calls.at(-1)?.[0]).not.toHaveProperty("token");
          expect(runTui.mock.calls.at(-1)?.[0]).not.toHaveProperty("password");
        }

        expect(sessionGateway.close).toHaveBeenCalledOnce();
        expect(restoreTerminalState.mock.calls).toEqual([
          ["pre-setup tui", { resumeStdinIfPaused: false }],
          ["post-setup tui", { resumeStdinIfPaused: false }],
        ]);
        expectNoteContains(
          "Systemd user services are not available inside this container.",
          "Container runtime",
        );
        expectNoteTitleNotCalled("Systemd");
        expect(gatewayServiceInstall).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["probe", "child"])(
    "closes a session gateway on %s failure before TUI launch",
    async (source) => {
      await withPlatform("linux", async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        const failure = new Error(`${source} failed`);
        const child = createDeferred();
        void child.promise.catch(() => {});
        waitForGatewayReachable.mockImplementationOnce(() => {
          if (source === "probe") {
            return Promise.reject(failure);
          }
          child.reject(failure);
          return new Promise(() => {});
        });
        const sessionGateway = { wait: child.promise, close: vi.fn(async () => {}) };
        startOnboardingGatewayProcess.mockResolvedValueOnce(sessionGateway);

        await expect(
          finalize("quickstart", {
            opts: { installDaemon: undefined, skipHealth: false },
          }),
        ).rejects.toBe(failure);

        expect(runTui).not.toHaveBeenCalled();
        expect(sessionGateway.close).toHaveBeenCalledOnce();
      });
    },
  );

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

      await finalize("quickstart", {
        opts: { skipHealth: false },
        settings: { gatewayToken: "test-token" },
      });

      expect(runtime.error).not.toHaveBeenCalledWith("health failed");
      expectNoteContains("Setup was run without Gateway service install");
      expectNoteTitleNotCalled("Dashboard ready");
      expect(prompter.outro).toHaveBeenCalledWith(
        "Gateway not detected yet. Start now: openclaw gateway run",
      );
      expectUncalled(
        readSystemdUserLingerStatus,
        gatewayServiceIsLoaded,
        gatewayServiceInstall,
        gatewayServiceRestart,
        startGatewayService,
        prompter.confirm,
        prompter.select,
      );
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
