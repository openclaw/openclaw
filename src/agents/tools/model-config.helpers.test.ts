import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as authSource from "../auth-profiles/source-check.js";
import * as authStoreRuntime from "../auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import {
  hasProviderAuthForTool,
  resolveOpenAiImageMediaCandidate,
} from "./model-config.helpers.js";

vi.mock("../auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  readExternalCliBootstrapCredential: () => null,
  resolveExternalCliAuthProfiles: () => [],
}));

// A non-bundled provider is visible only when its config reaches env resolution.
const authMocks = vi.hoisted(() => ({ resolveEnvApiKey: vi.fn() }));

vi.mock("../model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-auth.js")>();
  return {
    ...actual,
    resolveEnvApiKey: authMocks.resolveEnvApiKey,
    hasRuntimeAvailableProviderAuth: (
      params: Parameters<typeof actual.hasRuntimeAvailableProviderAuth>[0],
    ) => {
      const envAuth = authMocks.resolveEnvApiKey(params.provider, params.env, {
        config: params.cfg,
        workspaceDir: params.workspaceDir,
      });
      return Boolean(envAuth?.apiKey) || actual.hasRuntimeAvailableProviderAuth(params);
    },
  };
});

const AGENT_DIR = "/tmp/openclaw-model-config-helper";
const MODEL = "gpt-5.5";

type Decision = ReturnType<typeof resolveOpenAiImageMediaCandidate>;
type Profiles = AuthProfileStore["profiles"];

const codexSubstitute = {
  kind: "substitute",
  provider: "codex",
  ref: `codex/${MODEL}`,
} satisfies Decision;
const openAiKeep = { kind: "keep", ref: `openai/${MODEL}` } satisfies Decision;
const drop = { kind: "drop" } satisfies Decision;

function providerConfig(
  provider: string,
  key: string,
  baseUrl = "https://api.openai.com/v1",
): OpenClawConfig {
  return { models: { providers: { [provider]: { baseUrl, apiKey: key, models: [] } } } };
}

const openAiRefCfg = providerConfig("openai", "openai:default");
const hatcheryCfg = providerConfig("hatchery", "sk-configured", "https://example.com/v1"); // pragma: allowlist secret

function billingCooldown(
  provider: string,
  offset = 60_000,
  profiles: Profiles = {},
): AuthProfileStore {
  return {
    ...store(profiles),
    usageStats: {
      [`inline-api-key:${provider}`]: {
        disabledUntil: Date.now() + offset,
        disabledReason: "billing",
      },
    },
  };
}

const store = (profiles: Profiles): AuthProfileStore => ({ version: 1, profiles });

const oauth = (provider: string): AuthProfileCredential => ({
  provider,
  type: "oauth",
  access: "oauth-test",
  refresh: "refresh-test",
  expires: Date.now() + 60_000,
});

const token = (provider: string): AuthProfileCredential => ({
  provider,
  type: "token",
  token: "token-test",
});

const apiKey = (provider: string, key = "direct-openai-key"): AuthProfileCredential => ({
  provider,
  type: "api_key",
  key,
});

const resolveMedia = (
  overrides: Partial<Parameters<typeof resolveOpenAiImageMediaCandidate>[0]> = {},
) =>
  resolveOpenAiImageMediaCandidate({
    agentDir: AGENT_DIR,
    authStore: store({}),
    openAiModel: MODEL,
    resolveCodexMediaRoute: () => ({ model: MODEL }),
    ...overrides,
  });

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  authMocks.resolveEnvApiKey
    .mockReset()
    .mockImplementation((provider: string, _env?: unknown, options?: { config?: unknown }) =>
      provider === "acme" && options?.config
        ? { apiKey: "sk-acme-env", source: "env: ACME_API_KEY" }
        : null,
    );
});

afterEach(() => vi.unstubAllEnvs());

describe("hasProviderAuthForTool", () => {
  it("does not select direct or subscription agent credentials for plugin scope", () => {
    const cfg: OpenClawConfig = {};
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "openai",
          providers: ["openai"],
          modelCatalog: { providers: { openai: { authScope: "plugin", models: [] } } },
        },
      ],
    });
    withPluginMetadataSnapshotScope(
      metadata,
      () => {
        for (const credential of [apiKey("openai"), oauth("openai")]) {
          const authStore = store({ "openai:profile": credential });
          expect(hasProviderAuthForTool({ cfg, provider: "openai", authStore })).toBe(false);
          expect(resolveMedia({ cfg, authStore })).toEqual({ kind: "drop" });
        }
      },
      { config: cfg, trustConfigIdentity: true },
    );
  });
  it("keeps a prepared missing auth source unavailable without probing storage", () => {
    const noStorage = () => {
      throw new Error("unexpected caller-thread auth storage access");
    };
    const probe = vi
      .spyOn(authSource, "hasAnyAuthProfileStoreSource")
      .mockImplementation(noStorage);
    const load = vi
      .spyOn(authStoreRuntime, "ensureAuthProfileStoreWithoutExternalProfiles")
      .mockImplementation(noStorage);
    const params = {
      provider: "unconfigured-provider",
      agentDir: AGENT_DIR,
      authProfileStoreSource: false,
    };
    try {
      expect(hasProviderAuthForTool(params)).toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      load.mockRestore();
    }
  });

  it("accepts env-key plugin provider auth only when config reaches env resolution", () => {
    const cfg = { models: { providers: {} } } as OpenClawConfig;
    expect(hasProviderAuthForTool({ provider: "acme", cfg, workspaceDir: "/ws" })).toBe(true);
    expect(authMocks.resolveEnvApiKey).toHaveBeenCalledWith("acme", undefined, {
      config: cfg,
      workspaceDir: "/ws",
    });
    expect(hasProviderAuthForTool({ provider: "acme" })).toBe(false);
  });

  it("accepts config-backed custom provider auth", () => {
    expect(hasProviderAuthForTool({ provider: "hatchery", cfg: hatcheryCfg })).toBe(true);
  });

  it("rejects providers without config, env, or profile auth", () => {
    expect(
      hasProviderAuthForTool({
        provider: "unconfigured-provider",
        runtimeLookup: {
          envApiKey: {
            aliasMap: {},
            candidateMap: {},
            authEvidenceMap: {},
            skipSetupProviderFallback: true,
          },
        },
      }),
    ).toBe(false);
    expect(authMocks.resolveEnvApiKey).toHaveBeenCalledTimes(1);
  });

  it("hides inline provider keys during billing cooldown, keeping profile fallback", () => {
    // Regression: omitting the store advertised inline keys during billing cooldown.
    const check = (authStore: AuthProfileStore) =>
      hasProviderAuthForTool({ provider: "hatchery", cfg: hatcheryCfg, authStore });

    expect(check(billingCooldown("hatchery"))).toBe(false);
    expect(check(billingCooldown("hatchery", -60_000))).toBe(true);
    expect(
      check(
        billingCooldown("hatchery", 60_000, {
          "hatchery:default": apiKey("hatchery", "sk-profile"),
        }),
      ),
    ).toBe(true);
  });
});

describe("resolveOpenAiImageMediaCandidate", () => {
  it("drops an implicit OpenAI image candidate while its inline key is in billing cooldown", () => {
    const cfg = providerConfig("openai", "sk-configured"); // pragma: allowlist secret

    expect(resolveMedia({ cfg })).toEqual(openAiKeep);
    expect(resolveMedia({ cfg, authStore: billingCooldown("openai") })).toEqual(drop);
  });

  it.each<[string, () => Profiles, OpenClawConfig | undefined, Decision]>([
    ["token auth", () => ({ "openai:token": token("openai") }), undefined, codexSubstitute],
    ["API-key auth", () => ({ "openai:api-key": apiKey("openai") }), undefined, openAiKeep],
    [
      "excluded subscription auth",
      () => ({
        "openai:api-key": { provider: "openai", type: "api_key" },
        "openai:chatgpt": oauth("openai"),
      }),
      { auth: { order: { openai: ["openai:api-key"] } } },
      drop,
    ],
    [
      "OAuth reference",
      () => ({ "openai:default": oauth("openai") }),
      openAiRefCfg,
      codexSubstitute,
    ],
    [
      "unresolved API-key reference",
      () => ({
        "openai:default": { provider: "openai", type: "api_key" },
        "openai:chatgpt": oauth("openai"),
      }),
      openAiRefCfg,
      codexSubstitute,
    ],
  ])("routes %s", (_name, profiles, cfg, expected) => {
    expect(resolveMedia({ cfg, authStore: store(profiles()) })).toEqual(expected);
  });
});
