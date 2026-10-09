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
  it.each([
    {
      name: "explicit headers and API win while omitted fields are filled",
      rows: [
        model("openai/gpt-5.5", { api: "openai-responses", headers: {} }),
        model("gpt-5.5", {
          api: "openai-completions",
          baseUrl: "https://relay.example.test/v1",
          headers: { "x-route": "custom" },
          params: { azureApiVersion: "2025-01-01" },
        }),
      ],
      key: "gpt-5.5",
      normalize: (id: string) => id.replace(/^openai\//u, ""),
      expected: model("openai/gpt-5.5", {
        api: "openai-responses",
        baseUrl: "https://relay.example.test/v1",
        headers: {},
        params: { azureApiVersion: "2025-01-01" },
      }),
    },
    {
      name: "omitted headers are filled",
      rows: [
        model("gpt-5.5", { api: "openai-responses" }),
        model("openai/gpt-5.5", { headers: { "x-route": "custom" } }),
      ],
      key: "gpt-5.5",
      normalize: (id: string) => id.replace(/^openai\//u, ""),
      expected: model("gpt-5.5", { api: "openai-responses", headers: { "x-route": "custom" } }),
    },
    ...[false, true].map((reverse) => {
      const rows = [
        model("Model", { input: ["text", "image"], contextTokens: 200_000 }),
        model("model", { input: ["text"], contextTokens: 1_000_000 }),
      ];
      if (reverse) {
        rows.reverse();
      }
      return {
        name: `normalized capabilities (reversed=${reverse})`,
        rows,
        key: "model",
        normalize: (id: string) => id.toLowerCase(),
        expected: rows[0],
      };
    }),
  ])("keeps first-row precedence: $name", ({ rows, key, normalize, expected }) => {
    expect([
      ...resolveMergedModelProviderModels({ models: rows, normalizeModelId: normalize }),
    ]).toEqual([[key, expected]]);
  });
});

type SelectionCase = {
  name: string;
  rows: ModelDefinitionConfig[];
  canonicalize?: (id: string) => string;
  queries: Array<
    [id: string, row: number | undefined, route?: "none" | "present", provider?: string]
  >;
  unchangedId?: string;
  ambientAliases?: boolean;
};

const selectionCases: SelectionCase[] = [
  ...[false, true].map(
    (declared) =>
      ({
        name: `ignores ambient aliases (declared=${declared})`,
        rows: [model("latest", { headers: { "x-route": "another-owner" } })],
        canonicalize: declared ? (id: string) => id : undefined,
        ambientAliases: true,
        queries: [["Model", undefined, "none"]],
      }) satisfies SelectionCase,
  ),

  {
    name: "first equivalent retains omissions",
    rows: [model("alias-a"), model("alias-b", { headers: { "x-route": "other-alias" } })],
    canonicalize: () => "canonical",
    queries: [["canonical", 0]],
  },
  ...[false, true].flatMap((reverse) =>
    [undefined, {}].map((headers) => {
      const exact = model("Model", {
        baseUrl: "https://exact.example.test/v1",
        ...(headers ? { headers } : {}),
      });
      const legacy = model("custom/Model", {
        headers: { "x-route": "legacy" },
        baseUrl: "https://legacy.example.test/v1",
      });
      return {
        name: `exact before legacy (reversed=${reverse}, headers=${headers ? "empty" : "omitted"})`,
        rows: reverse ? [exact, legacy] : [legacy, exact],
        queries: [
          ["Model", reverse ? 0 : 1, "none"],
          ["custom/Model", reverse ? 1 : 0, "present"],
          ["Model", reverse ? 0 : 1, "none"],
        ],
      } satisfies SelectionCase;
    }),
  ),
  {
    name: "trimmed same-provider legacy fallback",
    rows: [model(" CUSTOM/Model ", { headers: { "x-route": "legacy" } })],
    queries: [
      ["Model", 0],
      [" CUSTOM/Model ", 0],
      ["model", undefined],
      ["Model", undefined, undefined, "other"],
    ],
    unchangedId: " CUSTOM/Model ",
  },
  ...[false, true].map((reverse) => {
    const aliases: Record<string, string> = { latest: "middle", middle: "final" };
    const rows = [
      model("latest", { headers: { "x-route": "latest" } }),
      model("middle"),
      model("final", { headers: {} }),
    ];
    if (reverse) {
      rows.reverse();
    }
    return {
      name: `exact alias-chain rows (reversed=${reverse})`,
      rows,
      canonicalize: (id: string) => aliases[id] ?? id,
      queries: [
        ["middle", 1, "none"],
        ["final", reverse ? 0 : 2, "none"],
        ["latest", reverse ? 2 : 0, "present"],
        ["middle", 1, "none"],
      ],
    } satisfies SelectionCase;
  }),
  {
    name: "declared equivalents precede legacy fallback",
    rows: [
      model("custom/Model", { headers: { "x-route": "legacy" } }),
      model("latest", { headers: {} }),
    ],
    canonicalize: (id) => (id === "latest" ? "Model" : id.replace(/^custom\//u, "")),
    queries: [["Model", 1, "none"]],
  },
  {
    name: "a qualified request does not consume a declared equivalent",
    rows: [model("latest", { headers: {} })],
    canonicalize: (id) => (id === "latest" ? "Model" : id.replace(/^custom\//u, "")),
    queries: [["custom/Model", undefined]],
  },
];

describe("configured model row precedence", () => {
  it.each(selectionCases)(
    "selects $name",
    ({ rows, canonicalize, queries, unchangedId, ambientAliases }) => {
      if (ambientAliases) {
        providerModelNormalization.setCurrentManifestModelIdNormalizationPolicies(
          new Map([["custom", { aliases: { latest: "Model" } }]]),
        );
      }
      const route = createModelProviderRouteOverrideResolver({
        provider: "custom",
        canonicalizeModelId: canonicalize,
        authoredConfig: { models: { providers: { custom: { baseUrl: "", models: rows } } } },
      });
      for (const [id, index, presence, provider = "custom"] of queries) {
        expect(findConfiguredProviderModel({ models: rows }, provider, id, canonicalize)).toEqual(
          index === undefined ? undefined : rows[index],
        );
        if (presence !== undefined) {
          expect(route(id)).toBe(presence);
        }
      }
      if (unchangedId !== undefined) {
        expect(rows[0]?.id).toBe(unchangedId);
      }
    },
  );
});

describe("reused configured model lookups", () => {
  it.each(["fallback", "initialization"] as const)(
    "keeps nested lookups from corrupting the %s index",
    (phase) => {
      const first = model("custom/First");
      const second = model("custom/Second");
      let nested: ModelDefinitionConfig | undefined;
      let reentered = false;
      const canonicalize = vi.fn((id: string) => {
        if (phase === "initialization") {
          if (id === "alias") {
            nested = resolve("Second");
          }
          return id;
        }
        if (id === "First" && !reentered) {
          reentered = true;
          nested = resolve("Second");
        }
        return id === "target" || id === "Second" ? "match" : id;
      });
      const resolve: (id: string) => ModelDefinitionConfig | undefined =
        createConfiguredProviderModelResolver(
          {
            models: phase === "initialization" ? [first, model("alias"), second] : [first, second],
          },
          "custom",
          canonicalize,
        );
      const query = phase === "initialization" ? "Second" : "target";
      expect(resolve(query)).toBe(second);
      expect(nested).toBe(phase === "initialization" ? undefined : second);
      if (phase === "fallback") {
        expect(canonicalize.mock.calls).toEqual([
          ["target"],
          ["First"],
          ["Second"],
          ["First"],
          ["Second"],
        ]);
      }
      canonicalize.mockClear();
      expect(resolve(query)).toBe(second);
      if (phase === "fallback") {
        expect(canonicalize.mock.calls).toEqual([["target"], ["First"], ["Second"]]);
      }
    },
  );

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
    ["provider request timeout", {}, "present", 90],
    ["affirmative reasoning support", { supportsReasoningEffort: true }, "none"],
    [
      "native reasoning efforts",
      { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      "none",
    ],
    ["disabled reasoning", { supportsReasoningEffort: false }, "present"],
    ["malformed reasoning support", { supportsReasoningEffort: "true" }, "present"],
    ["empty effort list", { supportedReasoningEfforts: [] }, "present"],
    ["disabled effort", { supportedReasoningEfforts: ["none"] }, "present"],
    ["malformed effort", { supportedReasoningEfforts: ["high", false] }, "present"],
    ["store behavior", { supportsStore: false }, "present"],
    [
      "mixed metadata and behavior",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["high"], supportsStore: false },
      "present",
    ],
  ])(
    "classifies %s without discarding request behavior",
    (_label, compat, expected, timeoutSeconds?: number) => {
      const config = {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", compat }],
              timeoutSeconds,
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
    },
  );
});
