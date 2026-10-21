// Auth-choice model check tests cover warnings for mismatched model and auth config.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDefaultModelAuthStatus,
  resolveDefaultModelCatalogFacts,
  warnIfModelConfigLooksOff,
} from "./auth-choice.model-check.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ version: 1, profiles: {} })));
// mock-isolation: Model readiness compares fixture credentials without discovering host accounts.
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreAsync: async () => ensureAuthProfileStore(),
}));
const note = vi.fn(async (_message: string, _title?: string) => {});
const prompter = makePrompter({ note });

function modelConfig(
  model: string | { primary: string },
  providers?: NonNullable<OpenClawConfig["models"]>["providers"],
): OpenClawConfig {
  return {
    agents: { defaults: { model } },
    ...(providers ? { models: { providers } } : {}),
  };
}

function useSubscription(profile = "openai:subscription") {
  ensureAuthProfileStore.mockReturnValue(
    createAuthProfileStoreFixture({
      [profile]: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    }),
  );
}

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
} satisfies Pick<ModelCatalogEntry, "api" | "baseUrl">;
const chatGPTRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} satisfies Pick<ModelCatalogEntry, "api" | "baseUrl">;

function catalogEntry(
  id: string,
  name: string,
  route: Pick<ModelCatalogEntry, "api" | "baseUrl">,
): ModelCatalogEntry {
  return { id, name, provider: "openai", ...route };
}

describe("warnIfModelConfigLooksOff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  });

  it("accepts pending auth profiles collected by the current setup transaction", async () => {
    const config = modelConfig("anthropic/claude-sonnet-4-6");
    const pendingAuthProfiles = [
      {
        profileId: "anthropic:default",
        credential: createApiKeyCredential("anthropic", "test-anthropic-key"),
      },
    ];

    expect(
      await resolveDefaultModelAuthStatus(config, { env: {}, pendingAuthProfiles }),
    ).toMatchObject({
      status: "ready",
    });
    await warnIfModelConfigLooksOff(config, prompter, {
      env: {},
      pendingAuthProfiles,
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not use pending auth profiles from a different provider", async () => {
    const config = modelConfig("anthropic/claude-sonnet-4-6");

    await warnIfModelConfigLooksOff(config, prompter, {
      env: {},
      pendingAuthProfiles: [
        {
          profileId: "openai:default",
          credential: createApiKeyCredential("openai", "test-openai-key"),
        },
      ],
    });

    expect(note).toHaveBeenCalledWith(
      'No auth configured for provider "anthropic". The agent may fail until credentials are added. Run `openclaw models auth login --provider anthropic`, `openclaw configure`, or set an API key env var.',
      "Model check",
    );
  });

  it("keeps custom OpenAI-compatible provider auth separate from Codex OAuth profiles", async () => {
    useSubscription("openai:default");
    const config = modelConfig(
      { primary: "openai/gpt-5.5" },
      {
        openai: { baseUrl: "https://example.test/v1", models: [] },
      },
    );

    await warnIfModelConfigLooksOff(config, prompter);

    expect(note).toHaveBeenCalledWith(
      'No auth configured for provider "openai". The agent may fail until credentials are added. Run `openclaw models auth login --provider openai`, `openclaw configure`, or set an API key env var.',
      "Model check",
    );
  });

  it("accepts subscription auth but not key sources for gpt-5.3-codex-spark", async () => {
    const config = modelConfig("openai/gpt-5.3-codex-spark");
    expect(
      await resolveDefaultModelAuthStatus(config, { env: { OPENAI_API_KEY: "api-key" } }),
    ).toMatchObject({
      status: "missing",
      authRequirement: "subscription",
    });

    await warnIfModelConfigLooksOff(config, prompter, {
      env: { OPENAI_API_KEY: "api-key" },
    });
    const warning = note.mock.calls.flatMap(([message]) => message).join("\n");
    expect(warning).toContain("openclaw models auth login --provider openai");
    expect(warning).not.toContain("set an API key env var");

    useSubscription();
    expect(await resolveDefaultModelAuthStatus(config)).toMatchObject({
      status: "ready",
    });
  });

  it("maps incompatible route facts to status and recovery wording", async () => {
    useSubscription();
    const config = modelConfig("openai/gpt-5.6", { openai: { ...chatGPTRoute, models: [] } });

    expect(await resolveDefaultModelAuthStatus(config)).toMatchObject({
      status: "incompatible",
    });
    await warnIfModelConfigLooksOff(config, prompter);

    expect(note).toHaveBeenCalledWith(
      'Model route is incompatible for "openai/gpt-5.6": gpt-5.6 is available only through OpenAI Platform API-key authentication.',
      "Model check",
    );
  });

  it("uses selected static ChatGPT catalog facts for auth checks", async () => {
    useSubscription();
    const catalog = [catalogEntry("gpt-5.4-nano", "GPT 5.4 Nano", chatGPTRoute)];
    const config = modelConfig("openai/gpt-5.4-nano");

    const catalogFacts = resolveDefaultModelCatalogFacts(config, catalog);
    expect(catalogFacts.observedRoutes).toEqual([chatGPTRoute]);
    expect(
      await resolveDefaultModelAuthStatus(config, { observedRoutes: catalogFacts.observedRoutes }),
    ).toMatchObject({ status: "ready" });
  });

  it("matches shipped OpenAI aliases to their canonical catalog model", async () => {
    const catalog = [catalogEntry("gpt-5.4", "GPT 5.4", platformRoute)];
    const config = modelConfig("openai/gpt-5.4-codex");

    const catalogFacts = resolveDefaultModelCatalogFacts(config, catalog);
    expect(catalogFacts.observedRoutes).toEqual([platformRoute]);
    expect(
      await resolveDefaultModelAuthStatus(config, {
        env: { OPENAI_API_KEY: "api-key" },
        observedRoutes: catalogFacts.observedRoutes,
      }),
    ).toMatchObject({ status: "ready" });
  });

  it("uses every physical route when the first route lacks compatible auth", async () => {
    const platform = catalogEntry("gpt-5.4-nano", "GPT 5.4 Nano", platformRoute);
    const chatGPT = { ...platform, ...chatGPTRoute };
    const routeVariants = [platform, chatGPT];
    useSubscription();
    const config = modelConfig("openai/gpt-5.4-nano");

    const catalogFacts = resolveDefaultModelCatalogFacts(config, [platform], { routeVariants });
    expect(catalogFacts.observedRoutes).toEqual([platformRoute, chatGPTRoute]);
    expect(
      await resolveDefaultModelAuthStatus(config, { observedRoutes: catalogFacts.observedRoutes }),
    ).toMatchObject({ status: "ready" });
  });

  it("reports an unknown static transport as indeterminate instead of missing auth", async () => {
    const config = modelConfig("openai/gpt-5.4-nano");

    expect(await resolveDefaultModelAuthStatus(config)).toMatchObject({
      status: "indeterminate",
    });
    await warnIfModelConfigLooksOff(config, prompter);

    expect(note).toHaveBeenCalledWith(
      'Auth readiness could not be confirmed for "openai/gpt-5.4-nano". Verify the selected model route and credential source before continuing.',
      "Model check",
    );
  });
});
