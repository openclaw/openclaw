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

describe("warnIfModelConfigLooksOff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  });

  it.each(["anthropic", "openai"])(
    "checks pending %s credentials against the model provider",
    async (provider) => {
      const config = modelConfig("anthropic/claude-sonnet-4-6");
      const options = {
        env: {},
        pendingAuthProfiles: [
          {
            profileId: `${provider}:default`,
            credential: createApiKeyCredential(provider, "test-key"),
          },
        ],
      };
      expect(await resolveDefaultModelAuthStatus(config, options)).toMatchObject({
        status: provider === "anthropic" ? "ready" : "missing",
      });
      await warnIfModelConfigLooksOff(config, prompter, options);
      if (provider === "anthropic") {
        expect(note).not.toHaveBeenCalled();
      } else {
        expect(note).toHaveBeenCalledWith(
          'No auth configured for provider "anthropic". The agent may fail until credentials are added. Run `openclaw models auth login --provider anthropic`, `openclaw configure`, or set an API key env var.',
          "Model check",
        );
      }
    },
  );

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

  it.each([
    ["static ChatGPT route", "gpt-5.4-nano", "gpt-5.4-nano", [chatGPTRoute], true],
    ["canonical model alias", "gpt-5.4-codex", "gpt-5.4", [platformRoute], false],
    [
      "all physical route variants",
      "gpt-5.4-nano",
      "gpt-5.4-nano",
      [platformRoute, chatGPTRoute],
      true,
    ],
  ] as const)(
    "resolves catalog auth through %s",
    async (_name, model, canonical, routes, subscription) => {
      if (subscription) {
        useSubscription();
      }
      const config = modelConfig(`openai/${model}`);
      const catalog = routes.map((route) => ({
        id: canonical,
        name: canonical,
        provider: "openai",
        ...route,
      }));
      const { observedRoutes } = resolveDefaultModelCatalogFacts(
        config,
        catalog.slice(0, 1),
        routes.length > 1 ? { routeVariants: catalog } : undefined,
      );
      expect(observedRoutes).toEqual(routes);
      expect(
        await resolveDefaultModelAuthStatus(config, {
          ...(subscription ? {} : { env: { OPENAI_API_KEY: "api-key" } }),
          observedRoutes,
        }),
      ).toMatchObject({ status: "ready" });
    },
  );

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
