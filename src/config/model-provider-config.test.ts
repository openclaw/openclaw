import * as providerModelNormalization from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, describe, expect, it } from "vitest";
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

function resolver(rows: ModelDefinitionConfig[], canonicalize?: (id: string) => string) {
  return createConfiguredProviderModelResolver({ models: rows }, "custom", canonicalize);
}

function routed(id: string, fields: Partial<ModelDefinitionConfig> = {}) {
  return model(id, { headers: { "x-route": id }, ...fields });
}

afterEach(() =>
  providerModelNormalization.setCurrentManifestModelIdNormalizationPolicies(undefined),
);

function merged(models: ModelDefinitionConfig[], normalizeModelId: (id: string) => string) {
  return [...resolveMergedModelProviderModels({ models, normalizeModelId })];
}

it.each([false, true])("fills omissions but preserves authored API/headers (empty=%s)", (empty) => {
  const transport: Partial<ModelDefinitionConfig> = empty
    ? {
        api: "openai-completions",
        baseUrl: "https://relay.example.test/v1",
        params: { azureApiVersion: "2025-01-01" },
      }
    : {};
  const id = empty ? "openai/gpt-5.5" : "gpt-5.5";
  const first = model(id, { api: "openai-responses", ...(empty ? { headers: {} } : {}) });
  const later = model(empty ? "gpt-5.5" : "openai/gpt-5.5", {
    ...transport,
    headers: { "x-route": "custom" },
  });
  const expected = model(id, {
    ...transport,
    api: "openai-responses",
    headers: empty ? {} : { "x-route": "custom" },
  });
  const stripPrefix = (value: string) => value.replace(/^openai\//u, "");
  expect(merged([first, later], stripPrefix)).toEqual([["gpt-5.5", expected]]);
});

it.each([false, true])("keeps first-row capabilities (reversed=%s)", (reverse) => {
  const rows = [
    model("Model", { input: ["text", "image"], contextTokens: 200_000 }),
    model("model", { input: ["text"], contextTokens: 1_000_000 }),
  ];
  if (reverse) {
    rows.reverse();
  }
  expect(merged(rows, (id) => id.toLowerCase())).toEqual([["model", rows[0]]]);
});

type Query = [id: string, row: number | undefined, route?: "none" | "present", provider?: string];
function expectSelection(
  rows: ModelDefinitionConfig[],
  queries: Query[],
  canonicalize?: (id: string) => string,
) {
  const custom = { baseUrl: "", models: rows };
  const route = createModelProviderRouteOverrideResolver({
    provider: "custom",
    canonicalizeModelId: canonicalize,
    authoredConfig: { models: { providers: { custom } } },
  });
  for (const [id, index, presence, provider = "custom"] of queries) {
    expect(findConfiguredProviderModel({ models: rows }, provider, id, canonicalize)).toEqual(
      index === undefined ? undefined : rows[index],
    );
    if (presence !== undefined) {
      expect(route(id)).toBe(presence);
    }
  }
}

it.each([false, true])("ignores ambient aliases (declared=%s)", (declared) => {
  providerModelNormalization.setCurrentManifestModelIdNormalizationPolicies(
    new Map([["custom", { aliases: { latest: "Model" } }]]),
  );
  expectSelection(
    [routed("latest")],
    [["Model", undefined, "none"]],
    declared ? (id) => id : undefined,
  );
});

it("first equivalent retains omissions", () => {
  expectSelection([model("alias-a"), routed("alias-b")], [["canonical", 0]], () => "canonical");
});

it.each(
  [false, true].flatMap((reverse) => [undefined, {}].map((headers) => ({ reverse, headers }))),
)("exact before legacy ($reverse, headers=$headers)", ({ reverse, headers }) => {
  const exact = model("Model", {
    baseUrl: "https://exact.example.test/v1",
    ...(headers ? { headers } : {}),
  });
  const legacy = routed("custom/Model", { baseUrl: "https://legacy.example.test/v1" });
  expectSelection(reverse ? [exact, legacy] : [legacy, exact], [
    ["Model", reverse ? 0 : 1, "none"],
    ["custom/Model", reverse ? 1 : 0, "present"],
    ["Model", reverse ? 0 : 1, "none"],
  ]);
});

it("trimmed same-provider legacy fallback", () => {
  const rows = [routed(" CUSTOM/Model ")];
  expectSelection(rows, [
    ["Model", 0],
    [" CUSTOM/Model ", 0],
    ["model", undefined],
    ["Model", undefined, undefined, "other"],
  ]);
  expect(rows[0]?.id).toBe(" CUSTOM/Model ");
});

it.each([false, true])("exact alias-chain rows (reversed=%s)", (reverse) => {
  const aliases: Record<string, string> = { latest: "middle", middle: "final" };
  const rows = [routed("latest"), model("middle"), model("final", { headers: {} })];
  expectSelection(
    reverse ? rows.toReversed() : rows,
    [
      ["middle", 1, "none"],
      ["final", reverse ? 0 : 2, "none"],
      ["latest", reverse ? 2 : 0, "present"],
      ["middle", 1, "none"],
    ],
    (id) => aliases[id] ?? id,
  );
});

it.each([false, true])("declared equivalent versus qualified request (%s)", (qualified) => {
  expectSelection(
    [...(qualified ? [] : [routed("custom/Model")]), model("latest", { headers: {} })],
    qualified ? [["custom/Model", undefined]] : [["Model", 1, "none"]],
    (id) => (id === "latest" ? "Model" : id.replace(/^custom\//u, "")),
  );
});

describe("reused configured model lookups", () => {
  it("keeps fallback callbacks live, ordered, short-circuited, and throwable", () => {
    const first = model("custom/First");
    const second = model("custom/ Second");
    let matchFirst = false;
    let failure: Error | undefined;
    const canonicalize = (id: string) => {
      if (id === "Second" && matchFirst) {
        throw new Error("must short-circuit after the first match");
      }
      if ((id === "First" || id === "literal") && failure) {
        throw failure;
      }
      return id === "target" || id === "Second" || (id === "First" && matchFirst) ? "match" : id;
    };
    const resolve = resolver([first, second, model("literal")], canonicalize);
    expect(resolve("target")).toBe(second);
    matchFirst = true;
    expect(resolve("target")).toBe(first);
    expect(resolve("First")).toBe(first);
    failure = new Error("policy failure");
    expect(() => resolve("target")).toThrow(failure);
    expect(() => resolve("First")).toThrow(failure);
    expect(() => resolve("literal")).toThrow(failure);
    failure = undefined;
    expect(resolve("target")).toBe(first);
  });

  it.each([false, true])("retains alias prefixes and literal overwrites (%s)", (literal) => {
    const alias = model("alias");
    const exact = model("custom/First");
    const resolve = resolver([alias, model("custom/Second"), ...(literal ? [exact] : [])], (id) =>
      id === "alias" ? "custom/First" : ["target", "First", "Second"].includes(id) ? "match" : id,
    );
    expect(resolve("target")).toBe(literal ? exact : alias);
    expect(resolve("target")).toBe(literal ? exact : alias);
  });

  it("retains the published partial index after an initialization callback throws", () => {
    const first = model("custom/First");
    const failure = new Error("initialization failure");
    const canonicalize = (id: string) => {
      if (id === "broken") {
        throw failure;
      }
      return id;
    };
    const resolve = resolver([first, model("broken"), model("custom/Second")], canonicalize);
    expect(() => resolve("First")).toThrow(failure);
    expect(resolve("Second")).toBeUndefined();
    expect(resolve("First")).toBe(first);
  });
});

it.each([
  [{}, "none"],
  [{}, "present", 90],
  [{ supportsReasoningEffort: true }, "none"],
  [{ supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }, "none"],
  [{ supportsReasoningEffort: false }, "present"],
  [{ supportsReasoningEffort: "true" }, "present"],
  [{ supportedReasoningEfforts: [] }, "present"],
  [{ supportedReasoningEfforts: ["none"] }, "present"],
  [{ supportedReasoningEfforts: ["high", false] }, "present"],
  [{ supportsTemperature: false }, "none"],
  [{ codeMode: "preferred" }, "none"],
  [{ codeMode: "capable" }, "none"],
  [{ supportsTemperature: "false" }, "present"],
  [{ codeMode: "exact" }, "present"],
  [{ supportsStore: false }, "present"],
])("classifies %j as %s (timeout %s)", (compat, expected, timeoutSeconds?: number) => {
  const openai = { models: [{ id: "gpt-5.6-sol", compat }], timeoutSeconds };
  const config = { models: { providers: { openai } } } as never;

  const resolve = createModelProviderRouteOverrideResolver({
    provider: "openai",
    authoredConfig: config,
  });
  expect(resolve("gpt-5.6-sol")).toBe(expected);
});
