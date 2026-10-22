import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, TransformConfigFileParams } from "../../config/config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  fetchClawHubPromotion: vi.fn(),
  hasAvailableAuthForProvider: vi.fn(),
  applyAuthChoiceLoadedPluginProvider: vi.fn(),
  resolveManifestProviderAuthChoice: vi.fn(),
  resolveProviderInstallCatalogEntry: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  replaceConfigFile: vi.fn(),
  promptYesNo: vi.fn(),
  enablePluginInConfig: vi.fn(),
  repairRuntimePlugins: vi.fn(),
}));

vi.mock("../../infra/clawhub-promotions.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/clawhub-promotions.js")>(
    "../../infra/clawhub-promotions.js",
  );
  return { ...actual, fetchClawHubPromotion: mocks.fetchClawHubPromotion };
});
vi.mock("../../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: mocks.hasAvailableAuthForProvider,
}));
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  applyAuthChoiceLoadedPluginProvider: mocks.applyAuthChoiceLoadedPluginProvider,
}));
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: mocks.resolveManifestProviderAuthChoice,
}));
vi.mock("../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry: mocks.resolveProviderInstallCatalogEntry,
}));
vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));
vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
    replaceConfigFile: mocks.replaceConfigFile,
    transformConfigFile: async ({ transform }: TransformConfigFileParams<unknown>) => {
      const snapshot = await mocks.readConfigFileSnapshot();
      const transformed = await transform(
        snapshot.sourceConfig,
        { snapshot, previousHash: snapshot.hash, attempt: 0 },
        {},
      );
      await mocks.replaceConfigFile({
        sourceConfig: transformed.nextConfig,
        baseHash: snapshot.hash,
      });
      return transformed;
    },
  };
});
vi.mock("../../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));
vi.mock("../../plugins/enable.js", () => ({
  enablePluginWithCapabilityConsent: mocks.enablePluginInConfig,
}));
vi.mock("../runtime-plugin-install.js", () => ({
  repairModelSelectionRuntimePlugins: mocks.repairRuntimePlugins,
}));
vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: vi.fn(() => ({})),
}));

const { ClawHubRequestError } = await import("../../infra/clawhub-client.js");
const { promosClaimCommand } = await import("./claim.js");

function makeRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function runClaim(opts: Parameters<typeof promosClaimCommand>[1] = {}, runtime = makeRuntime()) {
  return promosClaimCommand("spring-models", opts, runtime);
}

async function rejectClaim(error: RegExp, opts: Parameters<typeof runClaim>[0] = {}) {
  await expect(runClaim(opts)).rejects.toThrow(error);
  expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
}

function writtenModels() {
  return mocks.replaceConfigFile.mock.calls[0]?.[0]?.sourceConfig.agents.defaults;
}

const now = Date.now();
const modelRef = "openrouter/example/model-alpha";
const providerPackage = "@openclaw/openrouter-provider";

function offer(overrides: Parameters<typeof makePromotion>[0]) {
  mocks.fetchClawHubPromotion.mockResolvedValue(makePromotion(overrides));
}

function makePromotion(overrides: Record<string, unknown> = {}) {
  return {
    slug: "spring-models",
    title: "Free Example models",
    blurb: "A limited-time offer.",
    status: "active",
    active: true,
    startsAt: now - 1_000,
    endsAt: now + 86_400_000,
    provider: "openrouter",
    authChoiceId: "openrouter-api-key",
    models: [{ modelRef, alias: "model-alpha", suggestedDefault: true }],
    signupUrl: "https://signup.example.com",
    ...overrides,
  };
}

function makeSnapshot(config: Record<string, unknown> = {}) {
  return {
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash-1",
    issues: [],
    config,
    sourceConfig: config,
    runtimeConfig: config,
  };
}

const authChoice = {
  pluginId: "openrouter",
  providerId: "openrouter",
  methodId: "api-key",
  choiceId: "openrouter-api-key",
  choiceLabel: "OpenRouter API key",
  optionKey: "openrouterApiKey",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot());
  mocks.readConfigFileSnapshotForWrite.mockImplementation(async () => ({
    snapshot: await mocks.readConfigFileSnapshot(),
    writeOptions: {},
  }));
  mocks.replaceConfigFile.mockResolvedValue(undefined);
  mocks.hasAvailableAuthForProvider.mockResolvedValue(true);
  mocks.resolveManifestProviderAuthChoice.mockReturnValue(authChoice);
  mocks.resolveProviderInstallCatalogEntry.mockReturnValue(undefined);
  mocks.loadManifestMetadataSnapshot.mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: [{ id: "openrouter", packageName: providerPackage }],
    }),
  );
  mocks.promptYesNo.mockResolvedValue(false);
  mocks.enablePluginInConfig.mockImplementation((cfg: unknown, pluginId: string) => ({
    config: cfg,
    enabled: true,
    pluginId,
  }));
  mocks.fetchClawHubPromotion.mockResolvedValue(makePromotion());
  mocks.repairRuntimePlugins.mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("promosClaimCommand", () => {
  it("registers promo models with aliases without changing the default", async () => {
    offer({ pluginNames: [providerPackage] });
    const runtime = makeRuntime();
    await runClaim({}, runtime);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const next = writtenModels();
    expect(next.models[modelRef]).toEqual({ alias: "model-alpha" });
    expect(next.model).toBeUndefined();
    expect(mocks.applyAuthChoiceLoadedPluginProvider).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith('Claimed "Free Example models".');
  });

  it("sets the suggested model as default with --set-default", async () => {
    await runClaim({ setDefault: true });
    expect(writtenModels().model.primary).toBe(modelRef);
    expect(mocks.repairRuntimePlugins).toHaveBeenCalledWith(
      expect.objectContaining({ model: modelRef }),
    );
  });

  it("skips aliases outside the models-aliases contract but still registers the model", async () => {
    offer({ models: [{ modelRef, alias: "bad alias [31m" }] });
    await runClaim();
    expect(writtenModels().models[modelRef]).toEqual({});
  });

  it("keeps an existing alias owner and reports the skip", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(
      makeSnapshot({
        agents: { defaults: { models: { "openrouter/other/model": { alias: "model-alpha" } } } },
      }),
    );
    await runClaim();
    const { models } = writtenModels();
    expect(models[modelRef].alias).toBeUndefined();
    expect(models["openrouter/other/model"].alias).toBe("model-alpha");
  });

  it("uses the supplied API key instead of reusing existing credentials", async () => {
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({
      config: { plugins: { entries: { openrouter: { enabled: true } } } },
    });
    await runClaim({ apiKey: "sk-test" });
    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "openrouter-api-key",
        setDefaultModel: false,
        opts: { openrouterApiKey: "sk-test" },
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
  });

  it("aborts when the auth flow asks for retry instead of completing", async () => {
    mocks.hasAvailableAuthForProvider.mockResolvedValue(false);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({
      config: {},
      retrySelection: true,
    });
    await rejectClaim(/not completed/, { apiKey: "sk-test" });
  });

  it("aborts when auth is still unavailable after the flow returns", async () => {
    mocks.hasAvailableAuthForProvider.mockResolvedValue(false);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });
    await rejectClaim(/not completed/, { apiKey: "sk-test" });
  });

  it("fails when the promotion's auth choice is unknown locally", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    await rejectClaim(/Update OpenClaw/);
  });

  it("fails when the auth choice belongs to a different provider", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue({
      ...authChoice,
      providerId: "another-provider",
    });
    await expect(runClaim()).rejects.toThrow(/refusing to configure/);
  });

  it("refuses a declared plugin package not owned by the resolved auth choice", async () => {
    offer({ pluginNames: ["@openclaw/other-provider"] });
    await rejectClaim(/requires plugin package/);
    expect(mocks.hasAvailableAuthForProvider).not.toHaveBeenCalled();
    expect(mocks.enablePluginInConfig).not.toHaveBeenCalled();
  });

  it("refuses models outside the promotion's provider", async () => {
    offer({ models: [{ modelRef: "sneaky-provider/model" }] });
    await rejectClaim(/outside its provider/);
  });

  it("enforces the window even when the payload claims active", async () => {
    offer({ active: true, endsAt: now - 60_000 });
    await rejectClaim(/ended/);
    offer({ active: true, startsAt: now + 60_000, endsAt: now + 86_400_000 });
    await rejectClaim(/not live/);
  });

  it("rechecks the window after authentication before updating model config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    offer({ active: true, endsAt: now + 60_000 });
    mocks.hasAvailableAuthForProvider.mockImplementation(async () => {
      vi.setSystemTime(now + 120_000);
      return true;
    });
    try {
      await rejectClaim(/ended/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves env references across auth before a withdrawn offer", async () => {
    await withOpenClawTestState(
      {
        label: "promo-auth-env",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_TEST_PROMO_PREFIX: "before-auth" },
      },
      async (state) => {
        await state.writeConfig({ messages: { responsePrefix: "${OPENCLAW_TEST_PROMO_PREFIX}" } });
        const raw = await fs.readFile(state.configPath, "utf8");
        const actual =
          await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
        mocks.readConfigFileSnapshot.mockImplementation(actual.readConfigFileSnapshot);
        mocks.readConfigFileSnapshotForWrite.mockImplementation(
          actual.readConfigFileSnapshotForWrite,
        );
        mocks.replaceConfigFile.mockImplementation(actual.replaceConfigFile);
        const promotion = makePromotion();
        mocks.fetchClawHubPromotion
          .mockResolvedValueOnce(promotion)
          .mockResolvedValueOnce({ ...promotion, active: false });
        mocks.applyAuthChoiceLoadedPluginProvider.mockImplementation(
          async ({ config }: { config: OpenClawConfig }) => {
            expect(config.messages?.responsePrefix).toBe("before-auth");
            await Promise.resolve();
            process.env.OPENCLAW_TEST_PROMO_PREFIX = "after-auth";
            expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
            return { config: { ...config, logging: { level: "debug" } } };
          },
        );
        await expect(runClaim({ apiKey: "synthetic-promo-input" })).rejects.toThrow(/not live yet/);
        expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledOnce();
        expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
          messages: { responsePrefix: "${OPENCLAW_TEST_PROMO_PREFIX}" },
          logging: { level: "debug" },
        });
        const fresh = await actual.readConfigFileSnapshot();
        expect(fresh.valid).toBe(true);
        expect(fresh.sourceConfig.messages?.responsePrefix).toBe("after-auth");
      },
    );
  });

  it("refuses actionable promotion changes after authentication", async () => {
    const initial = makePromotion();
    mocks.fetchClawHubPromotion.mockResolvedValueOnce(initial).mockResolvedValueOnce(
      makePromotion({
        models: [{ modelRef: "openrouter/example/model-beta", suggestedDefault: true }],
      }),
    );
    await rejectClaim(/changed while the claim was in progress/);
    expect(mocks.fetchClawHubPromotion).toHaveBeenCalledTimes(2);
  });

  it("runs the install path when the auth choice is not installed, even with existing auth", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    mocks.resolveProviderInstallCatalogEntry.mockReturnValue({
      ...authChoice,
      installSource: { npm: { packageName: providerPackage } },
    });
    offer({ pluginNames: [providerPackage] });
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });
    await runClaim();
    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({ authChoice: "openrouter-api-key" }),
    );
  });

  it("refuses to claim when the provider plugin is blocked by policy", async () => {
    mocks.enablePluginInConfig.mockImplementation((cfg: unknown, pluginId: string) => ({
      config: cfg,
      enabled: false,
      pluginId,
      reason: "denylisted",
    }));
    await rejectClaim(/plugin policy/);
  });

  it("maps 404 responses to a friendly not-found error", async () => {
    const requestError = new ClawHubRequestError({
      path: "/api/v1/promotions/nope",
      status: 404,
      body: "not found",
    });
    mocks.fetchClawHubPromotion.mockRejectedValue(requestError);
    await expect(promosClaimCommand("nope", {}, makeRuntime())).rejects.toMatchObject({
      message: expect.stringMatching(/not found or is not live/),
      cause: requestError,
    });
  });
});
