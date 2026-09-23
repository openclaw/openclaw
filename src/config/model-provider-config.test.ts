import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveMergedModelProviderModels,
  createModelProviderRouteOverrideResolver,
  findConfiguredProviderModel,
} from "./model-provider-config.js";
import type { ModelDefinitionConfig } from "./types.models.js";

function model(id: string, fields: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
    ...fields,
  };
}

afterEach(() => setCurrentManifestModelIdNormalizationPolicies(undefined));

describe("resolveMergedModelProviderModels", () => {
  it("keeps first-row fields and fills only omissions from canonical duplicates", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("openai/gpt-5.5", {
          api: "openai-responses",
          headers: {},
        }),
        model("gpt-5.5", {
          api: "openai-completions",
          baseUrl: "https://relay.example.test/v1",
          headers: { "x-route": "custom" },
          params: { azureApiVersion: "2025-01-01" },
        }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")).toEqual(
      model("openai/gpt-5.5", {
        api: "openai-responses",
        baseUrl: "https://relay.example.test/v1",
        headers: {},
        params: { azureApiVersion: "2025-01-01" },
      }),
    );
  });

  it("fills headers when the first canonical row omits them", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("gpt-5.5", { api: "openai-responses" }),
        model("openai/gpt-5.5", { headers: { "x-route": "custom" } }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")?.headers).toEqual({ "x-route": "custom" });
  });

  it.each([false, true])(
    "publishes only normalized keys with first-row capabilities (reversed=%s)",
    (reverse) => {
      const models = [
        model("Model", { input: ["text", "image"], contextTokens: 200_000 }),
        model("model", { input: ["text"], contextTokens: 1_000_000 }),
      ];
      if (reverse) {
        models.reverse();
      }
      const indexed = resolveMergedModelProviderModels({
        models,
        normalizeModelId: (id) => id.toLowerCase(),
      });
      expect([...indexed]).toEqual([["model", models[0]]]);
    },
  );
});

describe("configured model row precedence", () => {
  it("keeps the first equivalent row's omissions when there is no exact target", () => {
    const first = model("alias-a");
    const second = model("alias-b", { headers: { "x-route": "other-alias" } });
    expect(
      findConfiguredProviderModel(
        { models: [first, second] },
        "custom",
        "canonical",
        () => "canonical",
      ),
    ).toEqual(first);
  });

  it.each([false, true])("keeps exact rows ahead of legacy spellings (reversed=%s)", (reverse) => {
    for (const headers of [undefined, {}]) {
      const exact = model("Model", {
        baseUrl: "https://exact.example.test/v1",
        ...(headers ? { headers } : {}),
      });
      const legacy = model("custom/Model", {
        headers: { "x-route": "legacy" },
        baseUrl: "https://legacy.example.test/v1",
      });
      const models = reverse ? [exact, legacy] : [legacy, exact];
      const resolve = createModelProviderRouteOverrideResolver({
        provider: "custom",
        authoredConfig: { models: { providers: { custom: { baseUrl: "", models } } } },
      });
      expect(findConfiguredProviderModel({ models }, "custom", "Model")).toEqual(exact);
      expect(findConfiguredProviderModel({ models }, "custom", "custom/Model")).toEqual(legacy);
      expect([resolve("Model"), resolve("custom/Model"), resolve("Model")]).toEqual([
        "none",
        "present",
        "none",
      ]);
    }
  });

  it("uses trimmed same-provider legacy rows only as a final fallback", () => {
    const legacy = model(" CUSTOM/Model ", { headers: { "x-route": "legacy" } });
    expect(findConfiguredProviderModel({ models: [legacy] }, "custom", "Model")).toEqual(legacy);
    expect(findConfiguredProviderModel({ models: [legacy] }, "custom", " CUSTOM/Model ")).toEqual(
      legacy,
    );
    expect(findConfiguredProviderModel({ models: [legacy] }, "custom", "model")).toBeUndefined();
    expect(findConfiguredProviderModel({ models: [legacy] }, "other", "Model")).toBeUndefined();
    expect(legacy.id).toBe(" CUSTOM/Model ");
  });

  it.each([false, true])("keeps exact alias-chain rows stable (reversed=%s)", (reverse) => {
    const aliases: Record<string, string> = { latest: "middle", middle: "final" };
    const canonicalizeModelId = (id: string) => aliases[id] ?? id;
    const models = [
      model("latest", { headers: { "x-route": "latest" } }),
      model("middle"),
      model("final", { headers: {} }),
    ];
    if (reverse) {
      models.reverse();
    }
    const resolve = createModelProviderRouteOverrideResolver({
      provider: "custom",
      canonicalizeModelId,
      authoredConfig: { models: { providers: { custom: { baseUrl: "", models } } } },
    });
    for (const id of ["middle", "final", "latest", "middle"]) {
      const expected = models.find((row) => row.id === id);
      expect(findConfiguredProviderModel({ models }, "custom", id, canonicalizeModelId)).toEqual(
        expected,
      );
      expect(resolve(id)).toBe(id === "latest" ? "present" : "none");
    }
  });

  it("keeps caller-declared equivalents ahead of legacy fallback rows", () => {
    const alias = model("latest", { headers: {} });
    const models = [model("custom/Model", { headers: { "x-route": "legacy" } }), alias];
    const canonicalizeModelId = (id: string) =>
      id === "latest" ? "Model" : id.replace(/^custom\//u, "");
    expect(findConfiguredProviderModel({ models }, "custom", "Model", canonicalizeModelId)).toEqual(
      alias,
    );
    expect(
      findConfiguredProviderModel(
        { models: [alias] },
        "custom",
        "custom/Model",
        canonicalizeModelId,
      ),
    ).toBeUndefined();
    expect(
      createModelProviderRouteOverrideResolver({
        provider: "custom",
        canonicalizeModelId,
        authoredConfig: { models: { providers: { custom: { baseUrl: "", models } } } },
      })("Model"),
    ).toBe("none");
  });

  it.each([false, true])(
    "ignores other owners' ambient input aliases (declared=%s)",
    (declared) => {
      setCurrentManifestModelIdNormalizationPolicies(
        new Map([["custom", { aliases: { latest: "Model" } }]]),
      );
      const models = [model("latest", { headers: { "x-route": "another-owner" } })];
      const canonicalizeModelId = declared ? (id: string) => id : undefined;
      expect(
        findConfiguredProviderModel({ models }, "custom", "Model", canonicalizeModelId),
      ).toBeUndefined();
      expect(
        createModelProviderRouteOverrideResolver({
          provider: "custom",
          canonicalizeModelId,
          authoredConfig: { models: { providers: { custom: { baseUrl: "", models } } } },
        })("Model"),
      ).toBe("none");
    },
  );
});

describe("createModelProviderRouteOverrideResolver", () => {
  it.each([
    ["empty metadata", {}, "none"],
    ["affirmative reasoning support", { supportsReasoningEffort: true }, "none"],
    [
      "native reasoning efforts",
      { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      "none",
    ],
    [
      "combined reasoning metadata",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] },
      "none",
    ],
    ["disabled reasoning", { supportsReasoningEffort: false }, "present"],
    ["malformed reasoning support", { supportsReasoningEffort: "true" }, "present"],
    ["empty effort list", { supportedReasoningEfforts: [] }, "present"],
    ["non-native effort", { supportedReasoningEfforts: ["high", "custom"] }, "present"],
    ["disabled effort", { supportedReasoningEfforts: ["none"] }, "present"],
    ["malformed effort", { supportedReasoningEfforts: ["high", false] }, "present"],
    ["store behavior", { supportsStore: false }, "present"],
    [
      "mixed metadata and behavior",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["high"], supportsStore: false },
      "present",
    ],
  ])("classifies %s without discarding request behavior", (_label, compat, expected) => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.6-sol", compat }],
          },
        },
      },
    } as never;

    expect(
      createModelProviderRouteOverrideResolver({
        provider: "openai",
        authoredConfig: config,
      })("gpt-5.6-sol"),
    ).toBe(expected);
  });

  it("treats a provider request timeout as authored behavior", () => {
    expect(
      createModelProviderRouteOverrideResolver({
        provider: "openai",
        authoredConfig: {
          models: {
            providers: {
              openai: { baseUrl: "", timeoutSeconds: 90, models: [model("gpt-5.5")] },
            },
          },
        },
      })("gpt-5.5"),
    ).toBe("present");
  });
});
