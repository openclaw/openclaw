import { expect, it } from "vitest";
import type { buildModelAliasIndex as BuildModelAliasIndex } from "../../agents/model-selection.js";
import type { createModelVisibilityPolicy as CreateModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import type { parseInlineSessionDirectives as ParseInlineSessionDirectives } from "./directive-handling.parse.js";

type ModelStatusTestHarness = {
  resolveModelInfoReply: (
    overrides?: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]>,
  ) => ReturnType<typeof maybeHandleModelDirectiveInfo>;
  parseInlineSessionDirectives: typeof ParseInlineSessionDirectives;
  createModelVisibilityPolicy: typeof CreateModelVisibilityPolicy;
  buildModelAliasIndex: typeof BuildModelAliasIndex;
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
  } = harness;

  function nestedOpenRouterStatusFixture() {
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
    const reply = await resolveModelInfoReply(nestedOpenRouterStatusFixture());

    expect(reply?.text).toContain("[openrouter]");
    expect(reply?.text).toContain("openrouter/google/gemini-3-flash-preview");
    expect(reply?.text).not.toContain("\n[google]");
    expect(reply?.text).not.toContain("\n  • google/gemini-3-flash-preview");
  });
}
