import { expect, it } from "vitest";
import { modelDefinition, providerConfig } from "../../agents/model-auth.fixtures.test-support.js";
import type { buildModelAliasIndex as BuildModelAliasIndex } from "../../agents/model-selection.js";
import type { createModelVisibilityPolicy as CreateModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/config.js";
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

export function registerModelStatusDirectiveTests(harness: ModelStatusTestHarness): void {
  const {
    resolveModelInfoReply,
    parseInlineSessionDirectives,
    createModelVisibilityPolicy,
    buildModelAliasIndex,
  } = harness;

  it("resolves inherited policy aliases with the default-scoped index in the picker", async () => {
    const cfg = {
      commands: { text: true },
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          model: { primary: "provider-a/model-a" },
          models: { "provider-a/model-a": { alias: "approved" } },
          modelPolicy: { allow: ["approved"] },
        },
        entries: {
          main: { models: { "provider-b/model-b": { alias: "approved" } } },
        },
      },
    } as unknown as OpenClawConfig;
    const scope = { cfg, defaultProvider: "provider-a", agentId: "main" };
    const policy = createModelVisibilityPolicy({ ...scope, catalog: [], defaultModel: "model-a" });
    const agentAliasIndex = buildModelAliasIndex(scope);

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
    const model = "google/gemini-3-flash-preview";
    const reply = await resolveModelInfoReply({
      directives: parseInlineSessionDirectives("/model status"),
      provider: "openrouter",
      model,
      defaultProvider: "openrouter",
      defaultModel: model,
      cfg: {
        commands: { text: true },
        ...providerConfig("openrouter", {
          baseUrl: "https://openrouter.example.test/api/v1",
          models: [modelDefinition(model, { name: "Gemini via OpenRouter" })],
        }),
      },
      allowedModelCatalog: [
        { provider: "google", id: "gemini-3-flash-preview" },
        { provider: "openrouter", id: model },
      ],
    });

    expect(reply?.text).toContain("[openrouter]");
    expect(reply?.text).toContain("openrouter/google/gemini-3-flash-preview");
    expect(reply?.text).not.toContain("\n[google]");
    expect(reply?.text).not.toContain("\n  • google/gemini-3-flash-preview");
  });
}
