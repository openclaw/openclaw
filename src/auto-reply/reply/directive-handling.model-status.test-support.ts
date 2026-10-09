import { expect, it } from "vitest";
import type { buildModelAliasIndex as BuildModelAliasIndex } from "../../agents/model-selection.js";
import type { createModelVisibilityPolicy as CreateModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import type { parseInlineSessionDirectives as ParseInlineSessionDirectives } from "./directive-handling.parse.js";

type ModelStatusTestHarness = {
  resolveModelInfoReply: (
    overrides?: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]>,
  ) => ReturnType<typeof maybeHandleModelDirectiveInfo>;
  parseInlineSessionDirectives: typeof ParseInlineSessionDirectives;
  createModelVisibilityPolicy: typeof CreateModelVisibilityPolicy;
  buildModelAliasIndex: typeof BuildModelAliasIndex;
  createSessionEntry: (overrides?: Partial<InternalSessionEntry>) => InternalSessionEntry;
  setAuthProfiles: (
    profiles: Record<
      string,
      | { type: "api_key"; provider: string; key: string }
      | { type: "oauth"; provider: string; access: string; refresh: string; expires: number }
    >,
  ) => void;
};

function modelDefinition(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

export function registerModelStatusDirectiveTests(harness: ModelStatusTestHarness): void {
  const {
    resolveModelInfoReply,
    parseInlineSessionDirectives,
    createModelVisibilityPolicy,
    buildModelAliasIndex,
    createSessionEntry,
    setAuthProfiles,
  } = harness;

  function nestedOpenRouterStatusFixture(configureDirectProvider: boolean) {
    return {
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      defaultProvider: "openrouter",
      defaultModel: "google/gemini-3-flash-preview",
      cfg: {
        commands: { text: true },
        models: {
          providers: {
            ...(configureDirectProvider
              ? {
                  google: {
                    baseUrl: "https://google.example.test/v1",
                    models: [modelDefinition("gemini-3-flash-preview", "Gemini 3 Flash")],
                  },
                }
              : {}),
            openrouter: {
              baseUrl: "https://openrouter.example.test/api/v1",
              models: [modelDefinition("google/gemini-3-flash-preview", "Gemini via OpenRouter")],
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [
        { provider: "google", id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
        {
          provider: "openrouter",
          id: "google/gemini-3-flash-preview",
          name: "Gemini via OpenRouter",
        },
      ],
    };
  }

  it("shows status for the allowed catalog without duplicate missing auth labels", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-4.1-mini": {},
            },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
      ],
    });

    expect(reply?.text).toContain("anthropic/claude-opus-4-6");
    expect(reply?.text).toContain("openai/gpt-4.1-mini");
    expect(reply?.text).not.toContain("claude-sonnet-4-1");
    expect(reply?.text).toContain("auth:");
    expect(reply?.text).not.toContain("missing (missing)");
  });

  it("expands provider wildcard models without retaining a rejected default", async () => {
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: { allow: ["anthropic/*"] },
          },
        },
      } as unknown as OpenClawConfig,
      allowedModelCatalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      ],
    });

    expect(reply?.text).toContain("anthropic/claude-sonnet-4-6");
    expect(reply?.text).toContain("anthropic/claude-opus-4-6");
    expect(reply?.text).not.toContain("  • openai/gpt-5.5");
  });

  it("resolves config-dependent policy refs identically in enforcement and picker", async () => {
    const cfg = {
      commands: { text: true },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
          },
          modelPolicy: { allow: ["openrouter:free"] },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      allowManifestNormalization: true,
      allowPluginNormalization: true,
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      cfg,
      allowedModelCatalog: policy.allowedCatalog,
    });

    expect(
      policy.allows({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" }),
    ).toBe(true);
    expect(reply?.text).toContain("openrouter/meta-llama/llama-3.3-70b-instruct:free");
    expect(reply?.text).not.toContain("anthropic/openrouter:free");
  });

  it("resolves inherited policy aliases with the default-scoped index in the picker", async () => {
    const cfg = {
      commands: { text: true },
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          model: { primary: "provider-a/model-a" },
          models: {
            "provider-a/model-a": { alias: "approved" },
          },
          modelPolicy: { allow: ["approved"] },
        },
        entries: {
          main: {
            models: {
              "provider-b/model-b": { alias: "approved" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "provider-a",
      defaultModel: "model-a",
      agentId: "main",
    });
    const agentAliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: "provider-a",
      agentId: "main",
    });

    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      cfg,
      activeAgentId: "main",
      defaultProvider: "provider-a",
      defaultModel: "model-a",
      aliasIndex: agentAliasIndex,
      allowedModelCatalog: policy.allowedCatalog,
    });

    expect(agentAliasIndex.byAlias.get("approved")?.ref).toEqual({
      provider: "provider-b",
      model: "model-b",
    });
    expect(policy.allows({ provider: "provider-a", model: "model-a" })).toBe(true);
    expect(policy.allows({ provider: "provider-b", model: "model-b" })).toBe(false);
    expect(reply?.text).toContain("provider-a/model-a");
    expect(reply?.text).not.toContain("provider-b/model-b");
  });

  it("hides missing-auth direct provider rows covered by OpenRouter nested model ids", async () => {
    const reply = await resolveModelInfoReply(nestedOpenRouterStatusFixture(false));

    expect(reply?.text).toContain("[openrouter]");
    expect(reply?.text).toContain("openrouter/google/gemini-3-flash-preview");
    expect(reply?.text).not.toContain("\n[google]");
    expect(reply?.text).not.toContain("\n  • google/gemini-3-flash-preview");
  });

  it("keeps explicitly configured direct provider rows next to OpenRouter nested ids", async () => {
    const reply = await resolveModelInfoReply(nestedOpenRouterStatusFixture(true));

    expect(reply?.text).toContain("[google]");
    expect(reply?.text).toContain("google/gemini-3-flash-preview");
    expect(reply?.text).toContain("[openrouter]");
    expect(reply?.text).toContain("openrouter/google/gemini-3-flash-preview");
  });

  it.each(["openclaw", "codex"])(
    "renders captured OpenAI auth facts for the selected %s runtime",
    async (runtime) => {
      setAuthProfiles({
        "openai:subscription": {
          type: "oauth",
          provider: "openai",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 3_600_000,
        },
        "openai:platform": { type: "api_key", provider: "openai", key: "synthetic-platform-key" },
      });
      const reply = await resolveModelInfoReply({
        directives: parseInlineSessionDirectives("/model status"),
        provider: "openai",
        model: "gpt-5.5",
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        sessionEntry: createSessionEntry({ agentRuntimeOverride: runtime }),
        cfg: { agents: { defaults: { model: "openai/gpt-5.5" } } },
        allowedModelCatalog: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
      });
      expect(reply?.text).toContain("openai:platform=");
      expect(reply?.text?.includes("openai:subscription=OAuth")).toBe(runtime === "codex");
    },
  );
}
