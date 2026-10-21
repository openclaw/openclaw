// Classic setup tests keep every workspace-owned effect on the configured default agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  readAuthority: vi.fn(),
  readSnapshot: vi.fn(),
  modelAuth: vi.fn(),
  writeConfig: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  setupSkills: vi.fn(),
  setupOfficialPlugins: vi.fn(),
  setupRecommendations: vi.fn(),
  setupPluginConfig: vi.fn(),
  finalizeSetup: vi.fn(),
}));

vi.mock("./navigation-prompter.js", () => ({
  runWizardWithPromptNavigation: async (
    prompter: WizardPrompter,
    run: (prompter: WizardPrompter) => Promise<void>,
  ) => await run(prompter),
}));

vi.mock("./setup.shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup.shared.js")>();
  return {
    ...actual,
    readSetupConfigAuthority: mocks.readAuthority,
    readSetupConfigFileSnapshot: mocks.readSnapshot,
    readValidSetupConfigFile: vi.fn(),
    requireRiskAcknowledgement: async ({ config }: { config: OpenClawConfig }) => config,
    resolveQuickstartGatewayDefaults: () => ({
      hasExisting: false,
      port: 18789,
      bind: "loopback",
      authMode: "token",
      tailscaleMode: "off",
    }),
    writeWizardConfigFile: mocks.writeConfig,
  };
});

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources: vi.fn(async () => ({ detections: [], providerDescriptors: [] })),
  listSetupMigrationOptions: vi.fn(async () => []),
  runSetupMigrationImport: vi.fn(),
}));

vi.mock("./setup.model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup.model-auth.js")>()),
  runSetupModelAuthStep: mocks.modelAuth,
}));

vi.mock("./setup.workspace.js", () => ({
  resolveSetupWorkspaceSelection: async () => ({
    workspaceDir: "/tmp/global-workspace",
    allowWorkspaceChange: false,
  }),
}));

vi.mock("./setup.secret-input.js", () => ({
  resolveSetupSecretInputString: vi.fn(async () => undefined),
}));

// mock-isolation: isolate wizard routing from gateway configuration prompts.
vi.mock("./setup.gateway-config.js", () => ({
  configureGatewayForSetup: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
    nextConfig,
    settings: { port: 18789, bind: "loopback", authMode: "token", gatewayToken: "test-token" },
  }),
}));

// mock-isolation: default-agent routing must not import real memory data.
vi.mock("./setup.memory-import.js", () => ({ runSetupMemoryImportStep: vi.fn() }));

vi.mock("./setup.official-plugins.js", () => ({
  setupOfficialPluginInstalls: mocks.setupOfficialPlugins,
}));

vi.mock("./setup.app-recommendations.js", () => ({
  setupAppRecommendations: mocks.setupRecommendations,
}));

// mock-isolation: observe the selected agent without configuring installed plugins.
vi.mock("./setup.plugin-config.js", () => ({ setupPluginConfig: mocks.setupPluginConfig }));

// mock-isolation: observe finalization without starting services or writing live state.
vi.mock("./setup.finalize.js", () => ({ finalizeSetupWizard: mocks.finalizeSetup }));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  printWizardHeader: vi.fn(),
  probeGatewayReachable: vi.fn(async () => ({ ok: false })),
  summarizeExistingConfig: vi.fn(() => ""),
}));

vi.mock("../commands/onboard-skills.js", () => ({ setupSkills: mocks.setupSkills }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  resolveGatewayPort: () => 18789,
  readConfigFileSnapshot: mocks.readSnapshot,
}));
vi.mock("../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));
vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices: vi.fn(() => []),
  formatPluginCompatibilityNotice: vi.fn(),
}));

import { runSetupWizard } from "./setup.js";

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const prompter = createWizardPrompter({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
});
const unchangedConfig = async (config: OpenClawConfig) => config;
const unchangedParams = async ({ config }: { config: OpenClawConfig }) => config;
const snapshot = (config: OpenClawConfig) => ({
  exists: true,
  valid: true,
  config,
  sourceConfig: config,
  sourceConfigBeforeMigrations: config,
  issues: [],
});

function runWizard(opts: OnboardOptions = {}) {
  return runSetupWizard(
    {
      acceptRisk: true,
      flow: "advanced",
      mode: "local",
      authChoice: "skip",
      installDaemon: false,
      skipChannels: true,
      skipSkills: true,
      skipSearch: true,
      skipHealth: true,
      skipHooks: true,
      skipUi: true,
      ...opts,
    },
    runtime,
    prompter,
  );
}

describe("runSetupWizard default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuthority.mockImplementation(async () => ({
      snapshot: await mocks.readSnapshot(),
      assertCurrent: () => {},
    }));
    mocks.modelAuth
      .mockReset()
      .mockImplementation(async ({ config }: { config: OpenClawConfig }) => ({
        config,
        authProfiles: [],
        persistAuthProfiles: async () => {},
      }));
    const config = {
      wizard: { securityAcknowledgedAt: "2026-07-01T00:00:00.000Z" },
      agents: {
        defaults: { workspace: "/tmp/global-workspace" },
        entries: {
          ops: { agentDir: "/tmp/ops-agent", workspace: "/tmp/ops-workspace" },
        },
      },
    } satisfies OpenClawConfig;
    mocks.readSnapshot.mockResolvedValue(snapshot(config));
    mocks.writeConfig.mockImplementation(async (nextConfig: OpenClawConfig) => ({
      path: "/tmp/openclaw.json",
      nextConfig,
    }));
    mocks.setupSkills.mockImplementation(unchangedConfig);
    mocks.setupOfficialPlugins.mockImplementation(unchangedParams);
    mocks.setupRecommendations.mockImplementation(
      async ({ config: nextConfig }: { config: OpenClawConfig }) => ({
        config: nextConfig,
        commitResult: async () => undefined,
      }),
    );
    mocks.setupPluginConfig.mockImplementation(unchangedParams);
    mocks.finalizeSetup.mockResolvedValue({ launchedTui: false });
  });

  it("revokes provider requests when config changes during an earlier setup prompt", async () => {
    await withOpenClawTestState({ label: "setup-parent-authority" }, async (state) => {
      const configForEndpoint = (endpoint: string): OpenClawConfig => ({
        agents: { entries: { main: {} } },
        models: {
          providers: {
            litellm: { baseUrl: `http://127.0.0.1:19479/${endpoint}/v1`, models: [] },
          },
        },
      });
      const config = configForEndpoint("original");
      await state.writeConfig(config);
      const { readSetupConfigAuthority } =
        await vi.importActual<typeof import("./setup.shared.js")>("./setup.shared.js");
      mocks.readAuthority.mockImplementation(readSetupConfigAuthority);
      let endpointReplaced = false;
      vi.mocked(prompter.select).mockImplementationOnce(async () => {
        await state.writeConfig(configForEndpoint("replacement"));
        endpointReplaced = true;
        return false;
      });
      const sendCredentialRequest = vi.fn();
      mocks.modelAuth.mockImplementationOnce(
        async ({ assertCurrent }: { assertCurrent?: () => void }) => {
          assertCurrent?.();
          sendCredentialRequest();
          return { config, authProfiles: [], persistAuthProfiles: async () => {} };
        },
      );

      await expect(
        runWizard({ authChoice: "litellm-api-key", workspace: state.workspaceDir }),
      ).rejects.toBeInstanceOf(ConfigMutationConflictError);
      expect(endpointReplaced).toBe(true);
      expect(sendCredentialRequest).not.toHaveBeenCalled();
      expect(mocks.writeConfig).not.toHaveBeenCalled();
    });
  });

  it("keeps concurrent gateway settings while carrying the telemetry choice", async () => {
    const config = {
      gateway: { mode: "local", port: 18789 },
      agents: { entries: { main: {} } },
    } satisfies OpenClawConfig;
    const current = { ...config, gateway: { ...config.gateway, port: 24444 } };
    mocks.readSnapshot.mockResolvedValueOnce(snapshot(config)).mockResolvedValue(snapshot(current));
    vi.mocked(prompter.select).mockResolvedValue(false);
    let persisted: OpenClawConfig | undefined;
    mocks.writeConfig.mockImplementation(async (nextConfig: OpenClawConfig) => {
      persisted = nextConfig;
      return { path: "/tmp/openclaw.json", nextConfig };
    });

    await runWizard({ flow: "quickstart" });

    expect(persisted?.telemetry).toEqual({ enabled: false, consentedAt: expect.any(String) });
    expect(persisted?.gateway?.port).toBe(24444);
  });

  it.each([false, true])(
    "checks first-agent authority by authored revision (changed=%s)",
    async (changed) => {
      const onboarding = await import("../commands/onboard-agent.js");
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      const runtimeConfig: OpenClawConfig = {
        ...config,
        plugins: { entries: { litellm: { enabled: true } } },
      };
      const creation = vi.spyOn(onboarding, "ensureOnboardingAgent").mockResolvedValueOnce({
        config: runtimeConfig,
        configBase: runtimeConfig,
        configHash: "created-revision",
        agentId: "main",
        createdAgent: true,
        bootstrapPending: false,
      });
      mocks.readAuthority.mockResolvedValue({
        snapshot: {
          exists: true,
          valid: true,
          config,
          hash: changed ? "foreign-revision" : "created-revision",
        },
        assertCurrent: () => {},
      });

      try {
        const result = runWizard({ workspace: "/tmp/global-workspace", agentName: "main" });
        if (changed) {
          await expect(result).rejects.toBeInstanceOf(ConfigMutationConflictError);
          expect(mocks.writeConfig).not.toHaveBeenCalled();
        } else {
          await result;
          expect(mocks.writeConfig).toHaveBeenCalledWith(
            expect.objectContaining({ plugins: runtimeConfig.plugins }),
            expect.any(Object),
          );
        }
      } finally {
        creation.mockRestore();
      }
    },
  );

  it("waits for recommendation persistence and propagates failure before finalization", async () => {
    const commitStarted = createDeferred();
    const commit = createDeferred();
    const failure = new Error("Recommendation persistence failed");
    // Keep the injected rejection observed when checking a missing-await regression.
    void commit.promise.catch(() => undefined);
    const commitResult = vi.fn(() => {
      commitStarted.resolve();
      return commit.promise;
    });
    mocks.setupRecommendations.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({ config, commitResult }),
    );
    const outcome = runWizard({ workspace: "/tmp/global-workspace" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      expect(await Promise.race([commitStarted.promise, outcome])).toBeUndefined();
      expect(commitResult).toHaveBeenCalledOnce();
      expect(mocks.writeConfig.mock.invocationCallOrder.at(-1)).toBeLessThan(
        commitResult.mock.invocationCallOrder[0]!,
      );
      expect(mocks.finalizeSetup).not.toHaveBeenCalled();
      commit.reject(failure);
      expect(await outcome).toBe(failure);
      expect(mocks.finalizeSetup).not.toHaveBeenCalled();
    } finally {
      commit.resolve();
      await outcome;
    }
  });

  it("uses the keyed default-agent workspace for all classic agent-owned effects", async () => {
    await runWizard({ workspace: "/tmp/global-workspace", skipSkills: false });

    expect(mocks.writeConfig.mock.lastCall).toMatchObject([
      { agents: { defaults: { workspace: "/tmp/global-workspace" } } },
      expect.any(Object),
    ]);
    const target = {
      agentId: "ops",
      workspaceDir: "/tmp/ops-workspace",
    };
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      target.workspaceDir,
      runtime,
      expect.objectContaining({ agentId: target.agentId }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      target.workspaceDir,
      runtime,
      prompter,
      expect.any(Object),
    );
    for (const effect of [
      mocks.setupOfficialPlugins,
      mocks.setupRecommendations,
      mocks.setupPluginConfig,
      mocks.finalizeSetup,
    ]) {
      expect(effect).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: target.workspaceDir }),
      );
    }
  });
});
