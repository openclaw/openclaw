// Model config helper tests cover provider auth detection across config and
// stored agent auth profiles for reusable media tools.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  hasDirectProviderApiKeyAuthForTool,
  hasProviderAuthForTool,
  resolveOpenAiFamilyMediaCandidate,
} from "./model-config.helpers.js";

describe("hasProviderAuthForTool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    expect(
      hasProviderAuthForTool({
        provider: "hatchery",
        authStore: {
          version: 1,
          profiles: {
            "hatchery:default": {
              provider: "hatchery",
              type: "api_key",
              key: "sk-profile", // pragma: allowlist secret
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects providers without config, env, or profile auth", () => {
    expect(hasProviderAuthForTool({ provider: "unconfigured-provider" })).toBe(false);
  });
});

describe("resolveOpenAiFamilyMediaCandidate", () => {
  const agentDir = "/tmp/openclaw-model-config-helper";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("substitutes Codex for canonical OpenAI OAuth-only media auth", () => {
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:chatgpt": {
          provider: "openai",
          type: "oauth",
          access: "oauth-test",
          refresh: "refresh-test",
          expires: Date.now() + 60_000,
        },
      },
    };

    expect(
      resolveOpenAiFamilyMediaCandidate({
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "substitute", provider: "codex", ref: "codex/gpt-5.5" });
  });

  it("substitutes Codex for canonical OpenAI token-only media auth", () => {
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          provider: "openai",
          type: "token",
          token: "token-test",
        },
      },
    };

    expect(
      resolveOpenAiFamilyMediaCandidate({
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "substitute", provider: "codex", ref: "codex/gpt-5.5" });
  });

  it("keeps OpenAI media when a direct API key profile exists", () => {
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:api-key": {
          provider: "openai",
          type: "api_key",
          key: "direct-openai-key",
        },
      },
    };

    expect(
      hasDirectProviderApiKeyAuthForTool({
        provider: "openai",
        agentDir,
        authStore,
        modelApi: "openai-responses",
      }),
    ).toBe(true);
    expect(
      resolveOpenAiFamilyMediaCandidate({
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "keep", ref: "openai/gpt-5.5" });
  });

  it("does not treat provider apiKey OAuth profile references as direct OpenAI media auth", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { openai: { apiKey: "openai:default" } } },
    };
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          provider: "openai",
          type: "oauth",
          access: "oauth-test",
          refresh: "refresh-test",
          expires: Date.now() + 60_000,
        },
      },
    };

    expect(
      hasDirectProviderApiKeyAuthForTool({
        provider: "openai",
        cfg,
        agentDir,
        authStore,
        modelApi: "openai-responses",
      }),
    ).toBe(false);
    expect(
      resolveOpenAiFamilyMediaCandidate({
        cfg,
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "substitute", provider: "codex", ref: "codex/gpt-5.5" });
  });

  it("treats provider apiKey API-key profile references as direct OpenAI media auth", () => {
    const cfg: OpenClawConfig = {
      models: { providers: { openai: { apiKey: "openai:default" } } },
    };
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          provider: "openai",
          type: "api_key",
          key: "direct-openai-key",
        },
      },
    };

    expect(
      hasDirectProviderApiKeyAuthForTool({
        provider: "openai",
        cfg,
        agentDir,
        authStore,
        modelApi: "openai-responses",
      }),
    ).toBe(true);
    expect(
      resolveOpenAiFamilyMediaCandidate({
        cfg,
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "keep", ref: "openai/gpt-5.5" });
  });

  it("does not treat legacy openai-codex profiles as canonical Codex OAuth", () => {
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          provider: "openai-codex",
          type: "oauth",
          access: "oauth-test",
          refresh: "refresh-test",
          expires: Date.now() + 60_000,
        },
      },
    };

    expect(
      resolveOpenAiFamilyMediaCandidate({
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "drop" });
  });

  it("does not treat legacy openai-codex token profiles as canonical Codex auth", () => {
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:token": {
          provider: "openai-codex",
          type: "token",
          token: "token-test",
        },
      },
    };

    expect(
      resolveOpenAiFamilyMediaCandidate({
        agentDir,
        authStore,
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "drop" });
  });

  it("drops OpenAI media when neither direct auth nor verified Codex route is available", () => {
    expect(
      resolveOpenAiFamilyMediaCandidate({
        agentDir,
        authStore: { version: 1, profiles: {} },
        capability: "image",
        openAiModel: "gpt-5.5",
        codexModel: "gpt-5.5",
      }),
    ).toEqual({ kind: "drop" });
  });
});
