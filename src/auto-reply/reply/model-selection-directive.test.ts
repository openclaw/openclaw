import { expect, it } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelDirectiveSelection } from "./model-selection-directive.js";
import { createModelSelectionState } from "./model-selection.js";

function config(defaults: AgentDefaultsConfig): OpenClawConfig {
  return { agents: { defaults } };
}
function resolveDirective(params: { cfg: OpenClawConfig; raw: string; agentId?: string }) {
  const base = { ...params, defaultProvider: "openai", defaultModel: "safe" };
  const policy = createModelVisibilityPolicy({ ...base, catalog: [] });
  return {
    policy,
    result: resolveModelDirectiveSelection({
      ...base,
      aliasIndex: buildModelAliasIndex(base),
      allowedModelKeys: policy.allowedKeys,
    }),
  };
}

it.each([
  [["fixture-route/namespace/*"], "fixture-route/namespace/reasoner", undefined, true],
  [["fixture-route/namespace/*"], "fixture-route/namespace-other/reasoner", undefined, false],
  [["openai/*"], "fixture-route/namespace/reasoner", ["fixture-route/namespace/*"], true],
  [["fixture-route/*"], "fixture-route/namespace/reasoner", ["openai/*"], false],
  [["openai/*"], "fixture-route/namespace/reasoner", [], true],
])("respects wildcard policy: %j %s %j %s", (allow, raw, agentAllow, allowed) => {
  const { result } = resolveDirective({
    cfg: {
      agents: {
        defaults: { modelPolicy: { allow } },
        entries: { ops: agentAllow ? { modelPolicy: { allow: agentAllow } } : {} },
      },
    },
    raw,
    agentId: "ops",
  });
  if (allowed) {
    expect(result.selection).toMatchObject({
      provider: "fixture-route",
      model: "namespace/reasoner",
    });
  } else {
    expect(result.selection).toBeUndefined();
    expect(result.error).toContain("is not allowed");
  }
});

it.each(["custom/custom/model", "chosen", "cho"])("resolves configured model %s", (raw) => {
  for (const allow of ["custom/model", "custom/custom/model"]) {
    const { result } = resolveDirective({
      cfg: {
        ...config({
          models: { "custom/custom/model": { alias: "chosen" } },
          modelPolicy: { allow: [allow] },
        }),
        models: {
          providers: {
            custom: { api: "openai-responses", baseUrl: "https://custom.example/v1", models: [] },
          },
        },
      },
      raw,
    });

    if (allow === "custom/custom/model") {
      expect.soft(result.selection).toMatchObject({ provider: "custom", model: "custom/model" });
    } else if (raw === "cho") {
      expect.soft(result.selection).toBeUndefined();
      expect.soft(result.error).toBeTruthy();
    } else {
      expect.soft(result.selection).toMatchObject({ provider: "custom", model: "model" });
    }
  }
});

it.each([undefined, { allow: [] }, { allow: ["openai/*"] }])(
  "permits uncataloged model: %j",
  async (modelPolicy) => {
    const cfg = config({ model: "anthropic/claude-sonnet-4-6", modelPolicy });
    const entries = [{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" }];
    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      hasModelDirective: true,
      preparedModelCatalog: { entries, routeVariants: entries },
    });
    const result = resolveModelDirectiveSelection({
      raw: "openai/gpt-5.6-luna",
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      aliasIndex: state.modelPolicy.policyAliasIndex,
      allowedModelKeys: state.allowedModelKeys,
      modelPolicy: state.modelPolicy,
      cfg,
    });
    expect(result).toMatchObject({
      selection: { provider: "openai", model: "gpt-5.6-luna", isDefault: false },
    });
  },
);

it("rejects a configured fallback that the explicit policy does not allow", () => {
  const { policy, result } = resolveDirective({
    cfg: config({
      model: { primary: "openai/safe", fallbacks: ["external/sensitive"] },
      modelPolicy: { allow: ["openai/safe"] },
    }),
    raw: "external/sensitive",
  });

  expect(policy.allowedKeys.has("external/sensitive")).toBe(false);
  expect(result.selection).toBeUndefined();
  expect(result.error).toContain('Model "external/sensitive" is not allowed.');
});
