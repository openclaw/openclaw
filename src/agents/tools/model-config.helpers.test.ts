// Model config helper tests cover provider auth detection across config and
// stored agent auth profiles for reusable media tools.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import {
  hasDirectProviderApiKeyAuthForTool,
  hasProviderAuthForTool,
  resolveOpenAiImageMediaCandidate,
} from "./model-config.helpers.js";

vi.mock("../auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: () => [],
}));

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

const openAiRefCfg: OpenClawConfig = {
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai:default",
        models: [],
      },
    },
  },
};

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
    codexModel: MODEL,
    ...overrides,
  });

const hasDirectOpenAiKey = (
  overrides: Partial<Parameters<typeof hasDirectProviderApiKeyAuthForTool>[0]> = {},
) =>
  hasDirectProviderApiKeyAuthForTool({
    provider: "openai",
    agentDir: AGENT_DIR,
    authStore: store({}),
    modelApi: "openai-responses",
    ...overrides,
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasProviderAuthForTool", () => {
  it("accepts config-backed custom provider auth", () => {
    const cfg = {
      models: {
        providers: {
          hatchery: {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(hasProviderAuthForTool({ provider: "hatchery", cfg })).toBe(true);
  });

  it("keeps auth-store profiles as valid tool auth", () => {
    // Tool-specific model selection should honor the same stored profile shape
    // used by agent sessions, not only process env/config keys.
    const authStore = store({
      "hatchery:default": {
        provider: "hatchery",
        type: "api_key",
        key: "sk-profile", // pragma: allowlist secret
      },
    });

    expect(hasProviderAuthForTool({ provider: "hatchery", authStore })).toBe(true);
  });

  it("rejects providers without config, env, or profile auth", () => {
    expect(hasProviderAuthForTool({ provider: "unconfigured-provider" })).toBe(false);
  });
});

describe("resolveOpenAiImageMediaCandidate", () => {
  const cases: Array<[string, AuthProfileStore, Decision]> = [
    [
      "canonical OpenAI OAuth-only media auth",
      store({ "openai:chatgpt": oauth("openai") }),
      codexSubstitute,
    ],
    [
      "canonical OpenAI token-only media auth",
      store({ "openai:token": token("openai") }),
      codexSubstitute,
    ],
    [
      "legacy openai-codex OAuth profiles",
      store({ "openai-codex:default": oauth("openai-codex") }),
      drop,
    ],
    [
      "legacy openai-codex token profiles",
      store({ "openai-codex:token": token("openai-codex") }),
      drop,
    ],
    ["no direct auth or verified Codex route", store({}), drop],
  ];

  it.each(cases)("resolves %s", (_label, authStore, expected) => {
    expect(resolveMedia({ authStore })).toEqual(expected);
  });

  it("keeps OpenAI media when a direct API key profile exists", () => {
    const authStore = store({ "openai:api-key": apiKey("openai") });

    expect(hasDirectOpenAiKey({ authStore })).toBe(true);
    expect(resolveMedia({ authStore })).toEqual(openAiKeep);
  });

  it("uses Codex when an ineligible direct API key profile is stale", () => {
    const authStore = store({
      "openai:api-key": { provider: "openai", type: "api_key" },
      "openai:chatgpt": oauth("openai"),
    });

    expect(hasDirectOpenAiKey({ authStore })).toBe(false);
    expect(resolveMedia({ authStore })).toEqual(codexSubstitute);
  });

  it("honors auth order when choosing between direct OpenAI and Codex media", () => {
    const cfg: OpenClawConfig = {
      auth: {
        order: {
          openai: ["openai:chatgpt"],
        },
      },
    };
    const authStore = store({
      "openai:api-key": apiKey("openai"),
      "openai:chatgpt": oauth("openai"),
    });

    expect(hasDirectOpenAiKey({ cfg, authStore })).toBe(false);
    expect(resolveMedia({ cfg, authStore })).toEqual(codexSubstitute);
  });

  it("drops Codex media when auth order excludes subscription-style auth", () => {
    const cfg: OpenClawConfig = {
      auth: {
        order: {
          openai: ["openai:api-key"],
        },
      },
    };
    const authStore = store({
      "openai:api-key": { provider: "openai", type: "api_key" },
      "openai:chatgpt": oauth("openai"),
    });

    expect(resolveMedia({ cfg, authStore })).toEqual(drop);
  });

  it("does not treat provider apiKey OAuth profile references as direct OpenAI media auth", () => {
    const authStore = store({ "openai:default": oauth("openai") });

    expect(hasDirectOpenAiKey({ cfg: openAiRefCfg, authStore })).toBe(false);
    expect(resolveMedia({ cfg: openAiRefCfg, authStore })).toEqual(codexSubstitute);
  });

  it("treats provider apiKey API-key profile references as direct OpenAI media auth", () => {
    const authStore = store({ "openai:default": apiKey("openai") });

    expect(hasDirectOpenAiKey({ cfg: openAiRefCfg, authStore })).toBe(true);
    expect(resolveMedia({ cfg: openAiRefCfg, authStore })).toEqual(openAiKeep);
  });

  it("does not treat unresolved provider apiKey profile references as direct auth", () => {
    const authStore = store({
      "openai:default": { provider: "openai", type: "api_key" },
      "openai:chatgpt": oauth("openai"),
    });

    expect(hasDirectOpenAiKey({ cfg: openAiRefCfg, authStore })).toBe(false);
    expect(resolveMedia({ cfg: openAiRefCfg, authStore })).toEqual(codexSubstitute);
  });
});
