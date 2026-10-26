import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
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

// Simulate config-scoped plugin auth without loading the plugin runtime.
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

function providerConfig(provider = "hatchery", key = "sk-configured"): OpenClawConfig {
  const entry = {
    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://example.com/v1",
    apiKey: key,
    models: [],
  };
  return { models: { providers: { [provider]: entry } } };
}

type Decision = ReturnType<typeof resolveOpenAiImageMediaCandidate>;
type Profiles = AuthProfileStore["profiles"];

const codexSubstitute = {
  kind: "substitute",
  provider: "codex",
  ref: `codex/${MODEL}`,
} satisfies Decision;
const openAiKeep = { kind: "keep", ref: `openai/${MODEL}` } satisfies Decision;
const drop = { kind: "drop" } satisfies Decision;

const openAiRefCfg = providerConfig("openai", "openai:default");

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
  authMocks.resolveEnvApiKey.mockReset();
  authMocks.resolveEnvApiKey.mockImplementation(
    (provider: string, _env?: unknown, options?: { config?: unknown }) =>
      provider === "acme" && options?.config
        ? { apiKey: "sk-acme-env", source: "env: ACME_API_KEY" }
        : null,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  it("accepts env-key plugin provider auth only when config reaches env resolution", () => {
    // "acme" is not in models.json, so custom-provider auth is false; the only
    // path to true is the config-aware env lookup.
    const cfg = { models: { providers: {} } } as OpenClawConfig;
    expect(hasProviderAuthForTool({ provider: "acme", cfg, workspaceDir: "/ws" })).toBe(true);
    expect(authMocks.resolveEnvApiKey).toHaveBeenCalledWith("acme", undefined, {
      config: cfg,
      workspaceDir: "/ws",
    });
    expect(hasProviderAuthForTool({ provider: "acme" })).toBe(false);
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

  it("hides inline keys during billing cooldown, keeping profile fallback", () => {
    const available = (offset: number, profiles: Profiles = {}) =>
      hasProviderAuthForTool({
        provider: "hatchery",
        cfg: providerConfig(),
        authStore: {
          ...store(profiles),
          usageStats: {
            "inline-api-key:hatchery": {
              disabledUntil: Date.now() + offset,
              disabledReason: "billing",
            },
          },
        },
      });
    expect(available(60_000)).toBe(false);
    expect(available(-60_000)).toBe(true);
    expect(available(60_000, { "hatchery:default": apiKey("hatchery", "sk-profile") })).toBe(true);
  });
});

describe("resolveOpenAiImageMediaCandidate", () => {
  it("drops an implicit OpenAI image candidate while its inline key is in billing cooldown", () => {
    const cfg = providerConfig("openai");

    expect(resolveMedia({ cfg })).toEqual(openAiKeep);
    expect(
      resolveMedia({
        cfg,
        authStore: {
          version: 1,
          profiles: {},
          usageStats: {
            "inline-api-key:openai": {
              disabledUntil: Date.now() + 60_000,
              disabledReason: "billing" as const,
            },
          },
        },
      }),
    ).toEqual(drop);
  });

  it.each<[string, Profiles, Decision, OpenClawConfig?]>([
    ["token-only subscription", { "openai:token": token("openai") }, codexSubstitute],
    ["direct API key", { "openai:api-key": apiKey("openai") }, openAiKeep],
    [
      "subscription excluded by auth order",
      {
        "openai:api-key": { provider: "openai", type: "api_key" },
        "openai:chatgpt": oauth("openai"),
      },
      drop,
      { auth: { order: { openai: ["openai:api-key"] } } },
    ],
    [
      "OAuth profile reference",
      { "openai:default": oauth("openai") },
      codexSubstitute,
      openAiRefCfg,
    ],
    [
      "unresolved API key reference",
      {
        "openai:default": { provider: "openai", type: "api_key" },
        "openai:chatgpt": oauth("openai"),
      },
      codexSubstitute,
      openAiRefCfg,
    ],
  ])("routes %s media auth", (_name, profiles, expected, cfg) => {
    expect(resolveMedia({ cfg, authStore: store(profiles) })).toEqual(expected);
  });
});
