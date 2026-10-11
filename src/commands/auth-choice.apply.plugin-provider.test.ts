// Auth-choice plugin provider tests cover loaded provider setup, plugin install, and credential routing.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { createManagedPluginArtifactConsentHandler } from "../plugins/capability-consent.js";
import { buildPluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import * as pluginEnable from "../plugins/enable.js";
import { metadataSnapshot } from "../plugins/management-service.test-helpers.js";
import {
  applyAuthChoiceLoadedPluginProvider,
  prepareAuthChoiceLoadedPluginProvider,
  runProviderPluginAuthMethod,
} from "../plugins/provider-auth-choice.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import type { ProviderPlugin, ProviderAuthMethod } from "../plugins/types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_LABEL,
  LOCAL_PROFILE_ID,
  LOCAL_API_KEY,
  LOCAL_DEFAULT_MODEL,
  buildProvider,
  buildProviderWithDefaultModelPatch,
  buildLocalProviderInstallCatalogEntry,
  buildInstalledLocalProviderPluginResult,
} from "./auth-choice.apply.plugin-provider.test-support.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";

type ResolveProviderInstallCatalogEntry =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntry;
type EnsureOnboardingPluginInstalled =
  typeof import("../commands/onboarding-plugin-install.js").ensureOnboardingPluginInstalled;
type ResolveManifestProviderAuthChoice =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoice;
type ResolvePluginSetupProvider =
  typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginSetupProvider;
type ModelSelectionRuntimePluginsResult =
  | { ok: true; cfg: ApplyAuthChoiceParams["config"]; codexInstalled: boolean }
  | { ok: false; message: string };

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const resolvePluginSetupProvider = vi.hoisted(() =>
  vi.fn<ResolvePluginSetupProvider>(() => undefined),
);
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-wizard.js").resolveProviderPluginChoiceCore>(),
);
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolvePluginSetupProvider,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
}));

const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoice>(() => undefined),
);
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));

const persistAuthProfileBatch = vi.hoisted(() =>
  vi.fn(async () => ({
    rollback: () => ({ unrevertedProfileIds: new Set<string>() }),
  })),
);
vi.mock("../agents/auth-profiles.js", () => ({
  persistAuthProfileBatch,
}));

const loadAuthProfileStoreWithoutExternalProfilesAsync = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreWithoutExternalProfilesAsync,
}));

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "default"));
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

const resolveDefaultAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir,
}));

const applyAuthProfileConfig = vi.hoisted(() => vi.fn((config) => config));
vi.mock("../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig,
}));

const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../infra/browser-open.js", () => ({
  openUrl,
}));

vi.mock("../infra/remote-env.js", () => ({
  isRemoteEnvironment,
}));

const createVpsAwareOAuthHandlers = vi.hoisted(() => vi.fn());
vi.mock("../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers,
}));

const resolveProviderInstallCatalogEntry = vi.hoisted(() =>
  vi.fn<ResolveProviderInstallCatalogEntry>(() => undefined),
);
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry,
}));

const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn<EnsureOnboardingPluginInstalled>(async ({ cfg, entry }) => ({
    cfg,
    installed: false,
    pluginId: entry?.pluginId ?? "missing-plugin",
    status: "skipped",
  })),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled,
}));

const ensureModelSelectionRuntimePlugins = vi.hoisted(() =>
  vi.fn(
    async ({
      cfg,
    }: {
      cfg: ApplyAuthChoiceParams["config"];
    }): Promise<ModelSelectionRuntimePluginsResult> => ({
      ok: true,
      cfg,
      codexInstalled: false,
    }),
  ),
);
vi.mock("../commands/runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureModelSelectionRuntimePlugins,
}));

const offerPostInstallMigrations = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: ApplyAuthChoiceParams["config"] }) => ({ config })),
);
vi.mock("../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));

const EXISTING_DEFAULT_MODEL = "amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0";

function expectPersistedProfile(profileId: string, credential: AuthProfileCredential): void {
  expect(persistAuthProfileBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      profiles: [{ profileId, credential }],
      agentDir: "/tmp/agent",
    }),
  );
}

function buildParams(overrides: Partial<ApplyAuthChoiceParams> = {}): ApplyAuthChoiceParams {
  return {
    authChoice: LOCAL_PROVIDER_ID,
    config: {},
    prompter: {
      note: vi.fn(async () => {}),
    } as unknown as ApplyAuthChoiceParams["prompter"],
    runtime: {} as ApplyAuthChoiceParams["runtime"],
    setDefaultModel: true,
    ...overrides,
  };
}

describe("applyAuthChoiceLoadedPluginProvider", () => {
  it("checks the persistent-effect guard before accepting plugin capabilities", async () => {
    const beforePersistentEffect = vi.fn(async () => {
      throw new Error("setup was cancelled");
    });
    const params = { ...buildParams(), beforePersistentEffect };
    params.prompter.confirm = vi.fn(async () => true);
    const entry = buildLocalProviderInstallCatalogEntry();
    resolveProviderInstallCatalogEntry.mockReturnValueOnce(entry);
    const enable = vi
      .spyOn(pluginEnable, "enablePluginWithCapabilityConsent")
      .mockResolvedValueOnce({ config: params.config, enabled: false, pluginId: entry.pluginId });
    try {
      await prepareAuthChoiceLoadedPluginProvider(params, (prepared) => prepared);
      const consent = expectDefined(
        enable.mock.calls[0]?.[2]?.onCapabilityConsent,
        "selected provider capability callback",
      );
      const manifest = expectDefined(
        metadataSnapshot({ id: entry.pluginId, enabled: false }).byPluginId.get(entry.pluginId),
        "selected provider manifest",
      );
      const review = buildPluginCapabilityConsentReview({
        pluginId: entry.pluginId,
        manifest,
        record: { source: "npm", spec: entry.install.npmSpec },
        config: params.config,
      });

      await expect(consent(review)).rejects.toThrow("setup was cancelled");
      expect(beforePersistentEffect).toHaveBeenCalledOnce();
      expect(persistAuthProfileBatch).not.toHaveBeenCalled();
      expect(resolvePluginProviders).not.toHaveBeenCalled();
    } finally {
      enable.mockRestore();
    }
  });

  it("does not load a selected provider when capability consent is declined", async () => {
    const params = buildParams();
    const entry = buildLocalProviderInstallCatalogEntry();
    resolveProviderInstallCatalogEntry.mockReturnValueOnce(entry);
    const enable = vi
      .spyOn(pluginEnable, "enablePluginWithCapabilityConsent")
      .mockResolvedValueOnce({
        config: params.config,
        enabled: false,
        pluginId: entry.pluginId,
        reason: "Plugin requires capability consent.",
      });
    try {
      const result = await applyAuthChoiceLoadedPluginProvider(params);
      expect(result?.config).toBe(params.config);
      expect(params.prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("capability consent"),
        entry.label,
      );
      expect(resolvePluginSetupProvider).not.toHaveBeenCalled();
      expect(resolvePluginProviders).not.toHaveBeenCalled();
      expect(persistAuthProfileBatch).not.toHaveBeenCalled();
    } finally {
      enable.mockRestore();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadAuthProfileStoreWithoutExternalProfilesAsync.mockReset().mockResolvedValue({
      version: 1,
      profiles: {},
    });
    applyAuthProfileConfig.mockImplementation((config) => config);
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolvePluginSetupProvider.mockReturnValue(undefined);
    resolveProviderInstallCatalogEntry.mockReturnValue(undefined);
    ensureOnboardingPluginInstalled.mockImplementation(async ({ cfg, entry }) => ({
      cfg,
      installed: false,
      pluginId: entry?.pluginId ?? "missing-plugin",
      status: "skipped",
    }));
    ensureModelSelectionRuntimePlugins.mockImplementation(async ({ cfg }) => ({
      ok: true,
      cfg,
      codexInstalled: false,
    }));
    offerPostInstallMigrations.mockImplementation(async ({ config }) => ({ config }));
  });

  it("offers only the selected provider's saved profiles during onboarding", async () => {
    const provider = buildProvider();
    const credential = {
      type: "api_key",
      provider: provider.id,
      key: "synthetic-saved-key",
    } as const;
    loadAuthProfileStoreWithoutExternalProfilesAsync.mockResolvedValue({
      version: 1,
      profiles: {
        "saved:local": credential,
        "saved:other": { ...credential, provider: "other" },
      },
    });
    const run = vi.spyOn(provider.auth[0]!, "run");
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({ provider, method: provider.auth[0]! });

    await prepareAuthChoiceLoadedPluginProvider(buildParams(), (result) => result);

    expect(run.mock.calls[0]?.[0].existingProfiles).toEqual([
      { profileId: "saved:local", credential },
    ]);
    expect(loadAuthProfileStoreWithoutExternalProfilesAsync).toHaveBeenCalledWith("/tmp/agent");
  });

  it("stages provider profiles until the caller commits them", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });

    const prepared = await prepareAuthChoiceLoadedPluginProvider(buildParams(), (result) => result);

    expect(prepared?.authProfiles).toEqual([
      {
        profileId: LOCAL_PROFILE_ID,
        credential: {
          type: "api_key",
          provider: LOCAL_PROVIDER_ID,
          key: LOCAL_API_KEY,
        },
      },
    ]);
    expect(persistAuthProfileBatch).not.toHaveBeenCalled();

    await prepared?.persistAuthProfiles([
      {
        profileId: LOCAL_PROFILE_ID,
        credential: {
          type: "api_key",
          provider: LOCAL_PROVIDER_ID,
          key: "test-key",
        },
      },
    ]);
    await prepared?.persistAuthProfiles();

    expect(persistAuthProfileBatch).toHaveBeenCalledOnce();
    expectPersistedProfile(LOCAL_PROFILE_ID, {
      type: "api_key",
      provider: LOCAL_PROVIDER_ID,
      key: "test-key",
    });
  });

  it("restores the exact entry config after provider install and auth staging", async () => {
    const provider = buildProvider();
    const entryConfig = {
      agents: { defaults: { model: { primary: EXISTING_DEFAULT_MODEL } } },
      wizard: { lastRunVersion: "entry-version" },
    };
    resolveProviderInstallCatalogEntry.mockReturnValue(buildLocalProviderInstallCatalogEntry());
    ensureOnboardingPluginInstalled.mockResolvedValue({
      ...buildInstalledLocalProviderPluginResult(),
      cfg: {
        ...entryConfig,
        plugins: { entries: { "local-provider-plugin": { enabled: true } } },
      },
    });
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValueOnce(null).mockReturnValueOnce({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });
    const note = vi.fn(async () => {});
    ensureModelSelectionRuntimePlugins.mockResolvedValue({
      ok: false,
      message: "GitHub Copilot agent runtime is required but unavailable.",
    });

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        config: entryConfig,
        prompter: { note } as unknown as ApplyAuthChoiceParams["prompter"],
      }),
    );

    expect(result).toEqual({ config: entryConfig, retrySelection: true });
    expect(result?.config).toBe(entryConfig);
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledOnce();
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(offerPostInstallMigrations).not.toHaveBeenCalled();
    expect(persistAuthProfileBatch).not.toHaveBeenCalled();
  });

  it("keeps an existing default when provider auth patches its own primary model", async () => {
    const provider = buildProviderWithDefaultModelPatch();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: expectDefined(provider.auth[0], "provider.auth[0] test invariant"),
    });
    const note = vi.fn(async () => {});

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        config: {
          agents: {
            defaults: {
              model: { primary: EXISTING_DEFAULT_MODEL },
              models: {
                [EXISTING_DEFAULT_MODEL]: { alias: "Bedrock" },
              },
            },
          },
        },
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
        preserveExistingDefaultModel: true,
      }),
    );

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: EXISTING_DEFAULT_MODEL,
    });
    expect(result?.config.agents?.defaults?.models).toEqual({
      [EXISTING_DEFAULT_MODEL]: { alias: "Bedrock" },
      [LOCAL_DEFAULT_MODEL]: { alias: "Local default" },
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      `Kept existing default model ${EXISTING_DEFAULT_MODEL}; ${LOCAL_DEFAULT_MODEL} is available.`,
      "Model configured",
    );
  });

  it("installs a verified official provider without capability review and retries setup resolution", async () => {
    await withTestDir({ prefix: "official-provider-setup-" }, async (artifactDir) => {
      const provider = buildProvider();
      const method = expectDefined(provider.auth[0], "provider.auth[0] test invariant");
      const run = method.run;
      method.run = async (context) => ({
        ...(await run(context)),
        configPatch: {
          plugins: {
            installs: { diffs: { source: "npm", spec: "provider-authored" } },
          },
        },
      });
      const installRecord = { source: "npm" as const, spec: "@openclaw/diffs" };
      const installed = { ...buildInstalledLocalProviderPluginResult(), pluginId: "diffs" };
      createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "diffs",
        packageName: "@openclaw/diffs",
      });
      resolveProviderInstallCatalogEntry.mockReturnValue({
        ...buildLocalProviderInstallCatalogEntry(),
        pluginId: "diffs",
        install: { npmSpec: "@openclaw/diffs" },
      });
      const onCapabilityConsent = vi.fn(async () => undefined);
      ensureOnboardingPluginInstalled.mockImplementation(async (params) => {
        const consent = createManagedPluginArtifactConsentHandler({
          ...params,
          config: params.cfg,
          source: "npm",
          onCapabilityConsent,
        });
        await consent.onBeforePluginArtifactCommit({
          pluginId: "diffs",
          stagedArtifactDir: artifactDir,
          mode: "install",
          sourceRecord: installRecord,
        });
        return {
          ...installed,
          cfg: {
            ...installed.cfg,
            plugins: { ...installed.cfg.plugins, installs: { diffs: installRecord } },
          },
        };
      });
      resolvePluginProviders.mockReturnValue([provider]);
      resolveProviderPluginChoice.mockReturnValueOnce(null).mockReturnValueOnce({
        provider,
        method,
      });

      const result = await prepareAuthChoiceLoadedPluginProvider(
        buildParams(),
        (prepared) => prepared,
      );
      expect(result?.pendingPluginInstalls).toEqual({ diffs: installRecord });
      expect(persistAuthProfileBatch).not.toHaveBeenCalled();

      expect(ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
      expect(onCapabilityConsent).not.toHaveBeenCalled();
      const [installParams] = ensureOnboardingPluginInstalled.mock.calls[0] ?? [];
      if (installParams === undefined) {
        throw new Error("expected plugin install params");
      }
      expect(installParams.entry?.pluginId).toBe("diffs");
      expect(installParams.entry?.label).toBe(LOCAL_PROVIDER_LABEL);
      expect(installParams.workspaceDir).toBe("/tmp/workspace");
      expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
      expect(result?.config.agents?.defaults?.model).toEqual({
        primary: LOCAL_DEFAULT_MODEL,
      });
    });
  });

  it("merges provider config patches and emits provider notes", async () => {
    applyAuthProfileConfig.mockImplementation(((
      config: {
        auth?: {
          profiles?: Record<string, { provider: string; mode: string }>;
        };
      },
      profile: { profileId: string; provider: string; mode: string },
    ) => ({
      ...config,
      auth: {
        profiles: {
          ...config.auth?.profiles,
          [profile.profileId]: {
            provider: profile.provider,
            mode: profile.mode,
          },
        },
      },
    })) as never);

    const events: string[] = [];
    const note = vi.fn(async () => {
      events.push("note");
    });
    const method: ProviderAuthMethod = {
      id: "local",
      label: "Local",
      kind: "custom",
      run: async () => ({
        profiles: [
          {
            profileId: LOCAL_PROFILE_ID,
            credential: {
              type: "api_key",
              provider: LOCAL_PROVIDER_ID,
              key: LOCAL_API_KEY,
            },
          },
        ],
        configPatch: {
          models: {
            providers: {
              [LOCAL_PROVIDER_ID]: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:4000/v1",
                models: [],
              },
            },
          },
        },
        defaultModel: LOCAL_DEFAULT_MODEL,
        notes: ["Detected local provider runtime.", "Pulled model metadata."],
      }),
    };

    const result = await runProviderPluginAuthMethod({
      providerId: LOCAL_PROVIDER_ID,
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      },
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note,
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
      beforePersistentEffect: () => {
        events.push("lock");
      },
    });

    expect(result.defaultModel).toBe(LOCAL_DEFAULT_MODEL);
    expect(result.config.models?.providers?.[LOCAL_PROVIDER_ID]).toEqual({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:4000/v1",
      models: [],
    });
    expect(result.config.auth?.profiles?.[LOCAL_PROFILE_ID]).toEqual({
      provider: LOCAL_PROVIDER_ID,
      mode: "api_key",
    });
    expect(note).toHaveBeenCalledWith(
      "Detected local provider runtime.\nPulled model metadata.",
      "Provider notes",
    );
    expect(persistAuthProfileBatch).toHaveBeenCalledWith(
      expect.objectContaining({ stateDir: "/tmp/openclaw-state" }),
    );
    expect(events).toEqual(["note", "lock"]);
  });

  it("normalizes retired Google Gemini default models returned by auth methods", async () => {
    const method: ProviderAuthMethod = {
      id: "google",
      label: "Google",
      kind: "custom",
      run: async () => ({
        profiles: [],
        defaultModel: "google/gemini-3-pro-preview",
      }),
    };

    const result = await runProviderPluginAuthMethod({
      providerId: "google",
      config: {},
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
  });

  it("replaces provider-owned default model maps during auth migrations", async () => {
    const method: ProviderAuthMethod = {
      id: "local",
      label: "Local",
      kind: "custom",
      run: async () => ({
        profiles: [],
        configPatch: {
          agents: {
            defaults: {
              model: {
                primary: "claude-cli/claude-sonnet-4-6",
                fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
              },
              models: {
                "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
                "claude-cli/claude-opus-4-6": { alias: "Opus" },
                "openai/gpt-5.2": {},
              },
            },
          },
        },
        replaceDefaultModels: true,
        defaultModel: "claude-cli/claude-sonnet-4-6",
      }),
    };

    const result = await runProviderPluginAuthMethod({
      providerId: LOCAL_PROVIDER_ID,
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
            },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
              "anthropic/claude-opus-4-6": { alias: "Opus" },
              "openai/gpt-5.2": {},
            },
          },
        },
      },
      runtime: {} as ApplyAuthChoiceParams["runtime"],
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      method,
    });

    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "claude-cli/claude-sonnet-4-6",
      fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
      "openai/gpt-5.2": {},
    });
  });
});
