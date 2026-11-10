import fs from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig, TransformConfigFileParams } from "../../config/config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  auth: vi.fn(),
  applyAuth: vi.fn(),
  choice: vi.fn(),
  catalog: vi.fn(),
  metadata: vi.fn(),
  read: vi.fn(),
  prepare: vi.fn(),
  write: vi.fn(),
  prompt: vi.fn(),
  enable: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("../../infra/clawhub-promotions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-promotions.js")>()),
  fetchClawHubPromotion: mocks.fetch,
}));
// mock-isolation: Model credential availability is fixture-owned, never read from host auth storage.
vi.mock("../../agents/model-auth.js", () => ({ hasAvailableAuthForProvider: mocks.auth }));
// mock-isolation: Test auth flow outcomes without interactive sign-in or credential writes.
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  applyAuthChoiceLoadedPluginProvider: mocks.applyAuth,
}));
// mock-isolation: Supply auth-choice ownership independently of installed host plugins.
vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: mocks.choice,
}));
// mock-isolation: Exercise catalog-only installation with a fixed package catalog.
vi.mock("../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry: mocks.catalog,
}));
// mock-isolation: Package ownership uses synthetic manifest metadata, not the host registry.
vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.metadata,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.read,
  readConfigFileSnapshotForWrite: mocks.prepare,
  replaceConfigFile: mocks.write,
  transformConfigFile: async ({ transform }: TransformConfigFileParams<unknown>) => {
    const snapshot = await mocks.read();
    const transformed = await transform(
      snapshot.sourceConfig,
      { snapshot, previousHash: snapshot.hash, attempt: 0 },
      {},
    );
    await mocks.write({ sourceConfig: transformed.nextConfig, baseHash: snapshot.hash });
    return transformed;
  },
}));
// mock-isolation: Confirmation decisions are fixture-controlled without terminal interaction.
vi.mock("../../cli/prompt.js", () => ({ promptYesNo: mocks.prompt }));
// mock-isolation: Exercise allowed and denied plugin policy without changing host plugin state.
vi.mock("../../plugins/enable.js", () => ({ enablePluginWithCapabilityConsent: mocks.enable }));
// mock-isolation: Observe repair requests without downloading or installing runtime plugins.
vi.mock("../runtime-plugin-install.js", () => ({
  repairModelSelectionRuntimePlugins: mocks.repair,
}));
// mock-isolation: Auth flow mocks do not need an interactive terminal prompter.
vi.mock("../../wizard/clack-prompter.js", () => ({ createClackPrompter: vi.fn(() => ({})) }));

const { ClawHubRequestError } = await import("../../infra/clawhub-client.js");
const { promosClaimCommand } = await import("./claim.js");
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
const runClaim = (opts: Parameters<typeof promosClaimCommand>[1] = {}) =>
  promosClaimCommand("spring-models", opts, runtime);
const writtenModels = () => mocks.write.mock.calls[0]?.[0]?.sourceConfig.agents.defaults;
async function rejectClaim(error: RegExp, opts: Parameters<typeof runClaim>[0] = {}) {
  await expect(runClaim(opts)).rejects.toThrow(error);
  expect(mocks.write).not.toHaveBeenCalled();
}

const now = Date.now();
const modelRef = "openrouter/example/model-alpha";
const providerPackage = "@openclaw/openrouter-provider";
const promotion = {
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
};
const offer = (overrides: Record<string, unknown>) =>
  mocks.fetch.mockResolvedValue({ ...promotion, ...overrides });
const snapshot = (config: OpenClawConfig = {}) => ({
  valid: true,
  hash: "hash-1",
  sourceConfig: config,
  runtimeConfig: config,
});
const authChoice = {
  pluginId: "openrouter",
  providerId: "openrouter",
  choiceId: "openrouter-api-key",
  optionKey: "openrouterApiKey",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(snapshot());
  mocks.prepare.mockImplementation(async () => ({
    snapshot: await mocks.read(),
    writeOptions: {},
  }));
  mocks.write.mockResolvedValue(undefined);
  mocks.auth.mockResolvedValue(true);
  mocks.choice.mockReturnValue(authChoice);
  mocks.catalog.mockReturnValue(undefined);
  mocks.metadata.mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: [{ id: "openrouter", packageName: providerPackage }],
    }),
  );
  mocks.prompt.mockResolvedValue(false);
  mocks.enable.mockImplementation((config: unknown, pluginId: string) => ({
    config,
    enabled: true,
    pluginId,
  }));
  offer({});
  mocks.repair.mockResolvedValue([]);
});

it.each([
  ["model-alpha", {}, { alias: "model-alpha" }],
  ["bad alias \u001b[31m", {}, {}],
  ["model-alpha", { "openrouter/other/model": { alias: "model-alpha" } }, {}],
])("registers alias %s without changing the default", async (alias, existing, expected) => {
  mocks.read.mockResolvedValue(snapshot({ agents: { defaults: { models: existing } } }));
  offer({
    pluginNames: [providerPackage],
    models: [{ modelRef, alias, suggestedDefault: true }],
  });
  await runClaim();
  const next = writtenModels();
  expect(next.models).toEqual({ ...existing, [modelRef]: expected });
  expect(next.model).toBeUndefined();
  expect(mocks.applyAuth).not.toHaveBeenCalled();
  expect(runtime.log).toHaveBeenCalledWith('Claimed "Free Example models".');
});

it("sets the suggested model as default with --set-default", async () => {
  await runClaim({ setDefault: true });
  expect(writtenModels().model.primary).toBe(modelRef);
  expect(mocks.repair).toHaveBeenCalledWith(expect.objectContaining({ model: modelRef }));
});

it.each([
  ["supplied key", "sk-test", true],
  ["catalog-only install", undefined, false],
])("runs auth for %s despite existing credentials", async (_name, apiKey, installed) => {
  if (!installed) {
    mocks.choice.mockReturnValue(undefined);
    mocks.catalog.mockReturnValue({
      ...authChoice,
      installSource: { npm: { packageName: providerPackage } },
    });
  }
  offer({ pluginNames: [providerPackage] });
  mocks.applyAuth.mockResolvedValue({ config: {} });
  await runClaim({ apiKey });
  expect(mocks.applyAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      authChoice: "openrouter-api-key",
      setDefaultModel: false,
      opts: apiKey ? { openrouterApiKey: apiKey } : undefined,
    }),
  );
});

it.each([
  ["the auth flow asks for retry", { config: {}, retrySelection: true }],
  ["auth is still unavailable", { config: {} }],
])("aborts when %s", async (_reason, result) => {
  mocks.auth.mockResolvedValue(false);
  mocks.applyAuth.mockResolvedValue(result);
  await rejectClaim(/not completed/, { apiKey: "sk-test" });
});

it.each([
  ["unknown auth choice", () => mocks.choice.mockReturnValue(undefined), /Update OpenClaw/],
  [
    "wrong provider",
    () => mocks.choice.mockReturnValue({ ...authChoice, providerId: "other" }),
    /refusing to configure/,
  ],
  ["unowned package", () => offer({ pluginNames: ["@other/provider"] }), /requires plugin package/],
  ["foreign model", () => offer({ models: [{ modelRef: "other/model" }] }), /outside its provider/],
  ["expired offer", () => offer({ endsAt: now - 60_000 }), /ended/],
  ["future offer", () => offer({ startsAt: now + 60_000 }), /not live/],
])("refuses %s before authentication or configuration", async (_name, setup, error) => {
  setup();
  await rejectClaim(error);
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.enable).not.toHaveBeenCalled();
});

it("rechecks the window after authentication before updating model config", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  offer({ endsAt: now + 60_000 });
  mocks.auth.mockImplementation(async () => {
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
      mocks.read.mockImplementation(actual.readConfigFileSnapshot);
      mocks.prepare.mockImplementation(actual.readConfigFileSnapshotForWrite);
      mocks.write.mockImplementation(actual.replaceConfigFile);
      mocks.fetch
        .mockResolvedValueOnce(promotion)
        .mockResolvedValueOnce({ ...promotion, active: false });
      mocks.applyAuth.mockImplementation(async ({ config }: { config: OpenClawConfig }) => {
        expect(config.messages?.responsePrefix).toBe("before-auth");
        await Promise.resolve();
        process.env.OPENCLAW_TEST_PROMO_PREFIX = "after-auth";
        expect(await fs.readFile(state.configPath, "utf8")).toBe(raw);
        return { config: { ...config, logging: { level: "debug" } } };
      });
      await expect(runClaim({ apiKey: "synthetic-promo-input" })).rejects.toThrow(/not live yet/);
      expect(mocks.write).toHaveBeenCalledOnce();
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
  mocks.fetch.mockResolvedValueOnce(promotion).mockResolvedValueOnce({
    ...promotion,
    models: [{ modelRef: "openrouter/example/model-beta", suggestedDefault: true }],
  });
  await rejectClaim(/changed while the claim was in progress/);
});

it("refuses to claim when the provider plugin is blocked by policy", async () => {
  mocks.enable.mockImplementation((config: unknown, pluginId: string) => ({
    config,
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
  mocks.fetch.mockRejectedValue(requestError);
  await expect(promosClaimCommand("nope", {}, runtime)).rejects.toMatchObject({
    message: expect.stringMatching(/not found or is not live/),
    cause: requestError,
  });
});
