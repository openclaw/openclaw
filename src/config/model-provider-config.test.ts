import * as providerModelNormalization from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredProviderModelResolver,
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

afterEach(() =>
  providerModelNormalization.setCurrentManifestModelIdNormalizationPolicies(undefined),
);

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
      providerModelNormalization.setCurrentManifestModelIdNormalizationPolicies(
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

describe("reused configured model lookups", () => {
  it("keeps the first fallback short-circuited and prepares only repeated fallback demand", () => {
    const legacy = model("custom/Model");
    const models = [legacy, ...Array.from({ length: 64 }, (_, index) => model(`plain-${index}`))];
    const strip = vi.spyOn(providerModelNormalization, "stripSelfProviderModelPrefix");
    try {
      const resolve = createConfiguredProviderModelResolver({ models }, "custom");
      expect(strip).not.toHaveBeenCalled();
      expect(resolve("plain-0")).toBe(models[1]);
      expect(strip).toHaveBeenCalledTimes(models.length + 1);
      strip.mockClear();
      expect(resolve("Model")).toBe(legacy);
      expect(strip).toHaveBeenCalledTimes(2);
      strip.mockClear();
      expect(resolve("Model")).toBe(legacy);
      expect(strip).toHaveBeenCalledTimes(models.length + 1);
      strip.mockClear();
      legacy.name = "Updated row";
      expect(resolve("Model")).toBe(legacy);
      expect(resolve("Model")?.name).toBe("Updated row");
      expect(strip).toHaveBeenCalledTimes(2);
    } finally {
      strip.mockRestore();
    }
  });

  it("keeps an active first fallback scan stable when a callback prepares a nested lookup", () => {
    const first = model("custom/First");
    const second = model("custom/Second");
    let nested: ModelDefinitionConfig | undefined;
    let reentered = false;
    const canonicalize = vi.fn((id: string) => {
      if (id === "First" && !reentered) {
        reentered = true;
        nested = resolve("Second");
      }
      return id === "target" || id === "Second" ? "match" : id;
    });
    const resolve = createConfiguredProviderModelResolver(
      { models: [first, second] },
      "custom",
      canonicalize,
    );
    expect(resolve("target")).toBe(second);
    expect(nested).toBe(second);
    expect(canonicalize.mock.calls).toEqual([
      ["target"],
      ["First"],
      ["Second"],
      ["First"],
      ["Second"],
    ]);
    canonicalize.mockClear();
    expect(resolve("target")).toBe(second);
    expect(canonicalize.mock.calls).toEqual([["target"], ["First"], ["Second"]]);
  });

  it("keeps fallback callbacks live, ordered, short-circuited, and throwable", () => {
    const first = model("custom/First");
    const second = model("custom/ Second");
    let matchFirst = false;
    let failure: Error | undefined;
    const canonicalize = vi.fn((id: string) => {
      if ((id === "First" || id === "literal") && failure) {
        throw failure;
      }
      return id === "target" || id === "Second" || (id === "First" && matchFirst) ? "match" : id;
    });
    const resolve = createConfiguredProviderModelResolver(
      { models: [first, second, model("literal")] },
      "custom",
      canonicalize,
    );
    expect(resolve("target")).toBe(second);
    expect(canonicalize.mock.calls).toEqual([["literal"], ["target"], ["First"], ["Second"]]);
    canonicalize.mockClear();
    matchFirst = true;
    expect(resolve("target")).toBe(first);
    expect(canonicalize.mock.calls).toEqual([["target"], ["First"]]);
    canonicalize.mockClear();
    expect(resolve("First")).toBe(first);
    expect(canonicalize.mock.calls).toEqual([["First"]]);
    canonicalize.mockClear();
    failure = new Error("policy failure");
    expect(() => resolve("target")).toThrow(failure);
    expect(canonicalize.mock.calls).toEqual([["target"], ["First"]]);
    expect(() => resolve("First")).toThrow(failure);
    expect(() => resolve("literal")).toThrow(failure);
    failure = undefined;
    expect(resolve("target")).toBe(first);
  });

  it.each([false, true])(
    "retains alias-produced prefixes and literal overwrites (literal=%s)",
    (literal) => {
      const alias = model("alias");
      const exact = model("custom/First");
      const resolve = createConfiguredProviderModelResolver(
        { models: [alias, model("custom/Second"), ...(literal ? [exact] : [])] },
        "custom",
        (id) =>
          id === "alias"
            ? "custom/First"
            : ["target", "First", "Second"].includes(id)
              ? "match"
              : id,
      );
      expect(resolve("target")).toBe(literal ? exact : alias);
      expect(resolve("target")).toBe(literal ? exact : alias);
    },
  );

  it("does not retain a fallback projection observed during initialization", () => {
    const first = model("custom/First");
    const second = model("custom/Second");
    let nested: ModelDefinitionConfig | undefined;
    const resolve: (modelId: string) => ModelDefinitionConfig | undefined =
      createConfiguredProviderModelResolver(
        { models: [first, model("alias"), second] },
        "custom",
        (id) => {
          if (id === "alias") {
            nested = resolve("Second");
          }
          return id;
        },
      );
    expect(resolve("Second")).toBe(second);
    expect(nested).toBeUndefined();
    expect(resolve("Second")).toBe(second);
  });

  it("retains the published partial index after an initialization callback throws", () => {
    const first = model("custom/First");
    const failure = new Error("initialization failure");
    const canonicalize = vi.fn((id: string) => {
      if (id === "broken") {
        throw failure;
      }
      return id;
    });
    const resolve = createConfiguredProviderModelResolver(
      { models: [first, model("broken"), model("custom/Second")] },
      "custom",
      canonicalize,
    );
    expect(() => resolve("First")).toThrow(failure);
    canonicalize.mockClear();
    expect(resolve("Second")).toBeUndefined();
    expect(resolve("First")).toBe(first);
    expect(canonicalize.mock.calls).toEqual([["Second"], ["First"], ["First"]]);
  });
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
