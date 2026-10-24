import { vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { finalizeSetupWizard } from "./setup.finalize.js";

export function createFinalizeMocks() {
  const mocks = {
    runTui: vi.fn<(options: unknown) => Promise<void>>(async () => {}),
    restoreTerminalState: vi.fn(),
    probeGatewayReachable: vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({
      ok: true,
    })),
    waitForGatewayReachable: vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({
      ok: true,
    })),
    resolveControlUiHandoffTarget: vi.fn(async (params: { config: OpenClawConfig }) => ({
      documentUrl: "http://127.0.0.1:18789/",
      tlsConfig: params.config.gateway?.tls,
    })),
    waitForControlUiDocument: vi.fn(
      async (_params: {
        url: string;
        tlsConfig?: GatewayTlsConfig;
        onPending?: () => void;
      }): Promise<{ ready: true } | { ready: false; reason: string }> => ({ ready: true }),
    ),
    resolveAdvertisedControlUiLinks: vi.fn(async () => ({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    })),
    resolveLocalControlUiProbeLinks: vi.fn(() => ({
      httpUrl: "http://127.0.0.1:18789",
      wsUrl: "ws://127.0.0.1:18789",
    })),
    setupWizardShellCompletion: vi.fn(async () => {}),
    loadModelCatalog: vi.fn<(_params?: unknown) => Promise<unknown[]>>(async () => []),
    gatewayServiceInstall: vi.fn(async () => {}),
    gatewayServiceRestart: vi.fn<
      () => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>
    >(async () => ({ outcome: "completed" })),
    gatewayServiceUninstall: vi.fn(async () => {}),
    gatewayServiceIsLoaded: vi.fn(async () => false),
    gatewayServiceReadCommand: vi.fn(),
    startGatewayService: vi.fn(),
    resolveGatewayInstallToken: vi.fn(async () => ({ warnings: [] })),
    isSystemdUserServiceAvailable: vi.fn(async () => true),
    resolveSystemdUserServiceAccount: vi.fn(() => "test-user" as string | null),
    readSystemdUserLingerStatus: vi.fn(async () => ({ user: "test-user", linger: "yes" as const })),
    resolveSetupSecretInputString: vi.fn<() => Promise<string | undefined>>(async () => undefined),
    resolveExistingKey: vi.fn<(config: OpenClawConfig, provider: string) => string | undefined>(
      () => undefined,
    ),
    hasExistingKey: vi.fn<(config: OpenClawConfig, provider: string) => boolean>(() => false),
    hasKeyInEnv: vi.fn<(entry: Pick<PluginWebSearchProviderEntry, "envVars">) => boolean>(
      () => false,
    ),
    listConfiguredWebSearchProviders: vi.fn<
      (params?: { config?: OpenClawConfig }) => PluginWebSearchProviderEntry[]
    >(() => []),
    hasAuthProfileForProvider: vi.fn<
      (params: {
        provider: string;
        agentDir?: string;
        includeExternalCli?: boolean;
        type?: string;
      }) => boolean
    >(() => false),
    isContainerEnvironment: vi.fn(() => false),
    startOnboardingGatewayProcess: vi.fn(async () => ({
      wait: new Promise<void>(() => {}),
      close: vi.fn(async () => {}),
    })),
  };
  return {
    ...mocks,
    describeGatewayServiceRestart: (serviceNoun: string, result: { outcome: string }) =>
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
    resetFinalizeMocks: () => {
      mocks.runTui.mockClear();
      mocks.restoreTerminalState.mockClear();
      mocks.probeGatewayReachable.mockReset().mockResolvedValue({ ok: false, detail: "offline" });
      mocks.waitForGatewayReachable.mockReset().mockResolvedValue({ ok: true });
      mocks.resolveControlUiHandoffTarget.mockReset().mockImplementation(async ({ config }) => ({
        documentUrl: "http://127.0.0.1:18789/",
        tlsConfig: config.gateway?.tls,
      }));
      mocks.waitForControlUiDocument.mockReset().mockResolvedValue({ ready: true });
      mocks.resolveAdvertisedControlUiLinks.mockReset().mockResolvedValue({
        httpUrl: "http://127.0.0.1:18789",
        wsUrl: "ws://127.0.0.1:18789",
      });
      mocks.resolveLocalControlUiProbeLinks.mockReset().mockReturnValue({
        httpUrl: "http://127.0.0.1:18789",
        wsUrl: "ws://127.0.0.1:18789",
      });
      mocks.setupWizardShellCompletion.mockClear();
      mocks.gatewayServiceInstall.mockClear();
      mocks.gatewayServiceIsLoaded.mockReset().mockResolvedValue(false);
      mocks.gatewayServiceReadCommand.mockReset().mockResolvedValue(null);
      mocks.startGatewayService.mockReset();
      mocks.gatewayServiceRestart.mockReset().mockResolvedValue({ outcome: "completed" });
      mocks.gatewayServiceUninstall.mockReset();
      mocks.resolveGatewayInstallToken.mockClear();
      mocks.isSystemdUserServiceAvailable.mockReset().mockResolvedValue(true);
      mocks.resolveSystemdUserServiceAccount.mockReset().mockReturnValue("test-user");
      mocks.readSystemdUserLingerStatus.mockReset().mockResolvedValue({
        user: "test-user",
        linger: "yes",
      });
      mocks.resolveSetupSecretInputString.mockReset().mockResolvedValue(undefined);
      mocks.resolveExistingKey.mockReset().mockReturnValue(undefined);
      mocks.hasExistingKey.mockReset().mockReturnValue(false);
      mocks.hasKeyInEnv.mockReset().mockReturnValue(false);
      mocks.listConfiguredWebSearchProviders.mockReset().mockReturnValue([]);
      mocks.hasAuthProfileForProvider.mockReset().mockReturnValue(false);
      mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
      mocks.startOnboardingGatewayProcess.mockReset().mockResolvedValue({
        wait: new Promise<void>(() => {}),
        close: vi.fn(async () => {}),
      });
      mocks.loadModelCatalog.mockReset().mockResolvedValue([]);
    },
  };
}

export function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

export type FinalizeArgs = Parameters<typeof finalizeSetupWizard>[0];

export const sessionGatewayTuiCases = [
  ["return", false, true],
  ["reject", false, true],
  ["return", true, true],
  ["reject", true, true],
  ["return", false, false],
  ["reject", true, false],
] as const;

export const sessionGatewayTuiTarget = {
  boundGateway: { url: "ws://127.0.0.1:18789", token: "test-token" },
};

export type FinalizeArgsOverrides = Omit<Partial<FinalizeArgs>, "flow" | "opts" | "settings"> & {
  opts?: Partial<FinalizeArgs["opts"]>;
  settings?: Partial<FinalizeArgs["settings"]>;
};

export function createLaterPrompter() {
  return buildWizardPrompter(undefined, { defaultSelect: "later" });
}

export function createFinalizeArgs(
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
      ...settings,
    },
    prompter: createLaterPrompter(),
    runtime: createRuntime(),
    ...rest,
  };
}
