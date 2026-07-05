import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  fetchClawHubPromotion: vi.fn(),
  hasAvailableAuthForProvider: vi.fn(),
  applyAuthChoiceLoadedPluginProvider: vi.fn(),
  resolveManifestProviderAuthChoice: vi.fn(),
  resolveProviderInstallCatalogEntry: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  promptYesNo: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/clawhub.js")>("../../infra/clawhub.js");
  return {
    ...actual,
    fetchClawHubPromotion: mocks.fetchClawHubPromotion,
  };
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

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: vi.fn(() => ({})),
}));

const { ClawHubRequestError } = await import("../../infra/clawhub.js");
const { promosClaimCommand } = await import("./claim.js");

function makeRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
}

const now = Date.now();

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
    models: [
      { modelRef: "openrouter/example/model-alpha", alias: "model-alpha", suggestedDefault: true },
    ],
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
  mocks.replaceConfigFile.mockResolvedValue(undefined);
  mocks.hasAvailableAuthForProvider.mockResolvedValue(true);
  mocks.resolveManifestProviderAuthChoice.mockReturnValue(authChoice);
  mocks.resolveProviderInstallCatalogEntry.mockReturnValue(undefined);
  mocks.promptYesNo.mockResolvedValue(false);
  mocks.fetchClawHubPromotion.mockResolvedValue(makePromotion());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("promosClaimCommand", () => {
  it("registers promo models with aliases without changing the default", async () => {
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", {}, runtime);

    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.models["openrouter/example/model-alpha"]).toEqual({
      alias: "model-alpha",
    });
    expect(next.agents.defaults.model).toBeUndefined();
    expect(mocks.applyAuthChoiceLoadedPluginProvider).not.toHaveBeenCalled();
  });

  it("sets the suggested model as default with --set-default", async () => {
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", { setDefault: true }, runtime);

    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.model.primary).toBe("openrouter/example/model-alpha");
  });

  it("skips aliases outside the models-aliases contract but still registers the model", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({
        models: [{ modelRef: "openrouter/example/model-alpha", alias: "bad alias [31m" }],
      }),
    );
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", {}, runtime);

    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.models["openrouter/example/model-alpha"]).toEqual({});
  });

  it("keeps an existing alias owner and reports the skip", async () => {
    const existing = {
      agents: {
        defaults: {
          models: { "openrouter/other/model": { alias: "model-alpha" } },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot(existing));
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", {}, runtime);

    const next = mocks.replaceConfigFile.mock.calls[0]?.[0]?.nextConfig;
    expect(next.agents.defaults.models["openrouter/example/model-alpha"].alias).toBeUndefined();
    expect(next.agents.defaults.models["openrouter/other/model"].alias).toBe("model-alpha");
  });

  it("runs the provider auth choice when no credentials exist", async () => {
    // An explicit --api-key skips the reuse pre-check entirely; the only
    // hasAvailableAuthForProvider call is the post-apply revalidation.
    mocks.hasAvailableAuthForProvider.mockResolvedValue(true);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({
      config: { plugins: { entries: { openrouter: { enabled: true } } } },
    });
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", { apiKey: "sk-test" }, runtime);

    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "openrouter-api-key",
        setDefaultModel: false,
        opts: { openrouterApiKey: "sk-test" },
      }),
    );
    // Auth config write plus the model registration write.
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
  });

  it("runs the auth flow for an explicit --api-key even when other auth exists", async () => {
    // hasAvailableAuthForProvider stays true; the explicit key must not be ignored.
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });
    const runtime = makeRuntime();
    await promosClaimCommand("spring-models", { apiKey: "sk-explicit" }, runtime);

    expect(mocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { openrouterApiKey: "sk-explicit" } }),
    );
  });

  it("aborts when the auth flow asks for retry instead of completing", async () => {
    mocks.hasAvailableAuthForProvider.mockResolvedValue(false);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({
      config: {},
      retrySelection: true,
    });

    await expect(
      promosClaimCommand("spring-models", { apiKey: "sk-test" }, makeRuntime()),
    ).rejects.toThrow(/not completed/);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("aborts when auth is still unavailable after the flow returns", async () => {
    // Both the pre-check and the post-apply revalidation report no usable auth
    // (e.g. the provider plugin was disabled and the flow returned unchanged).
    mocks.hasAvailableAuthForProvider.mockResolvedValue(false);
    mocks.applyAuthChoiceLoadedPluginProvider.mockResolvedValue({ config: {} });

    await expect(
      promosClaimCommand("spring-models", { apiKey: "sk-test" }, makeRuntime()),
    ).rejects.toThrow(/not completed/);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("fails when the promotion's auth choice is unknown locally", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    mocks.resolveProviderInstallCatalogEntry.mockReturnValue(undefined);

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /Update OpenClaw/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("fails when the auth choice belongs to a different provider", async () => {
    mocks.resolveManifestProviderAuthChoice.mockReturnValue({
      ...authChoice,
      providerId: "another-provider",
    });

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /refusing to configure/,
    );
  });

  it("refuses models outside the promotion's provider", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ models: [{ modelRef: "sneaky-provider/model" }] }),
    );

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /outside its provider/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("reports ended promotions with their end date", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: false, endsAt: now - 86_400_000 }),
    );

    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(/ended/);
  });

  it("enforces the window even when the payload claims active", async () => {
    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: true, endsAt: now - 60_000 }),
    );
    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(/ended/);

    mocks.fetchClawHubPromotion.mockResolvedValue(
      makePromotion({ active: true, startsAt: now + 60_000, endsAt: now + 86_400_000 }),
    );
    await expect(promosClaimCommand("spring-models", {}, makeRuntime())).rejects.toThrow(
      /not live/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("maps 404 responses to a friendly not-found error", async () => {
    mocks.fetchClawHubPromotion.mockRejectedValue(
      new ClawHubRequestError({ path: "/api/v1/promotions/nope", status: 404, body: "not found" }),
    );

    await expect(promosClaimCommand("nope", {}, makeRuntime())).rejects.toThrow(
      /not found or is not live/,
    );
  });
});
