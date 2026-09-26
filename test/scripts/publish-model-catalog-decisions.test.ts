import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeModelCatalog } from "../../packages/model-catalog-core/src/model-catalog-normalize.js";
import type { ModelInferenceCapabilities } from "../../packages/model-catalog-core/src/model-catalog-types.js";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  validateAndSanitizeRemoteModelCatalogBundleV3,
} from "../../packages/model-catalog-core/src/remote-catalog-bundle.js";
import { assembleModelCatalogBundleV3 } from "../../scripts/lib/model-catalog-publication-wire.mts";
import {
  enrichModelCatalogPricing,
  runPublishModelCatalog,
} from "../../scripts/publish-model-catalog.mts";
import {
  parseRemoteModelCatalogWireBundle,
  projectRemoteModelCatalog,
} from "../../src/model-catalog/remote-bundle.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const inference = (limit: number): ModelInferenceCapabilities => ({
  chat: false,
  decision: {
    protocol: "fixture",
    input: ["text"],
    questions: { boolean: { probabilities: "boolean", abstention: false } },
    limits: { maxInputTokens: limit },
    billing: { unit: "tokens", source: "provider-catalog" },
  },
});

it("publishes native facts only on v3 while retaining legacy pricing-only records", async () => {
  const root = roots.make("catalog-decision-wire-");
  const dir = path.join(root, "extensions", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const seeds = Array.from({ length: 100 }, (_, i) => ({ id: "seed-" + i }));
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["anthropic", "openai", "typesafe", "openrouter", "sage"],
      modelCatalog: {
        providers: {
          anthropic: { models: seeds },
          openai: {
            defaultModel: "native",
            models: [...seeds, { id: "native", inference: inference(32000) }],
          },
          typesafe: {
            authScope: "plugin",
            runtimeHooks: { fake: true },
            defaultModel: "jev",
            models: [
              {
                id: "jev",
                inference: {
                  ...inference(64000),
                  decision: {
                    ...inference(64000).decision,
                    limits: { maxRequestTokens: 64000, maxStateAndQuestionTokens: 32000 },
                  },
                },
                headers: { authorization: "synthetic" },
                baseUrl: "https://never-publish.invalid",
              },
            ],
          },
          openrouter: {
            authScope: "agent",
            models: [
              { id: "typesafe/jev", inference: inference(32000) },
              { id: "dual", inference: { ...inference(32000), chat: true } },
              { id: "typesafe/free", inference: inference(32000) },
              { id: "typesafe/mixed-fees", inference: inference(32000) },
            ],
          },
          sage: {
            models: [
              {
                id: "units",
                inference: {
                  chat: false,
                  decision: {
                    protocol: "fixture",
                    input: ["text"],
                    billing: { unit: "decision-units", source: "provider-docs" },
                  },
                },
                cost: { input: 0, output: 0 },
              },
            ],
          },
        },
      },
      modelPricing: {
        providers: {
          openrouter: { openRouter: { provider: "openrouter" }, modelsDev: false, liteLLM: false },
        },
      },
    }),
  );
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === "https://openrouter.ai/api/v1/models?output_modalities=decisions") {
      return Response.json({
        data: [
          { id: "typesafe/jev", pricing: { prompt: "0.000000042", completion: "0" } },
          { id: "dual", pricing: { prompt: "0.000000042", completion: "0" } },
          { id: "typesafe/free", pricing: { prompt: "0", completion: "0" } },
          {
            id: "typesafe/mixed-fees",
            pricing: { prompt: "0.000000042", completion: "0", request: "0.1" },
          },
        ],
      });
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      return Response.json({
        data: [{ id: "dual", pricing: { prompt: "0.000009", completion: "0.000009" } }],
      });
    }
    if (url.includes("model_prices_and_context_window")) {
      return Response.json({
        "typesafe/jev": { input_cost_per_token: 0.000000042, output_cost_per_token: 0 },
        "typesafe/standalone": { input_cost_per_token: 0.000000043, output_cost_per_token: 0 },
      });
    }
    if (url === "https://models.opencode.ai/api.json") {
      return Response.json({});
    }
    throw new Error("Unexpected fixture request: " + url);
  };
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await runPublishModelCatalog({
    rootDir: root,
    sourceCommit: "synthetic-source",
    now: () => Date.now(),
    fetchImpl,
    args: ["--pricing", "--out", "v1.json", "--out-v2", "v2.json", "--out-v3", "v3.json"],
  });
  const load = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const v1 = parseRemoteModelCatalogBundle(load("v1.json")),
    v2 = parseRemoteModelCatalogBundleV2(load("v2.json")),
    v3 = validateAndSanitizeRemoteModelCatalogBundleV3(load("v3.json"));
  expect(calls).toContain("https://openrouter.ai/api/v1/models");
  expect(calls).toContain("https://openrouter.ai/api/v1/models?output_modalities=decisions");
  expect(v1.providers).not.toHaveProperty("typesafe");
  expect(v1.providers.openai).not.toHaveProperty("defaultModel");
  expect(v1.pricing?.["typesafe/jev"]).toMatchObject({
    input: expect.closeTo(0.042, 12),
    output: 0,
  });
  expect(v1.pricing?.["typesafe/standalone"]).toMatchObject({
    input: expect.closeTo(0.043, 12),
    output: 0,
  });
  expect(v2.models.some((model) => model.id === "jev")).toBe(false);
  expect(v2.providers).not.toHaveProperty("typesafe");
  expect(v2.providerPricing?.["typesafe/jev"]).toMatchObject({
    input: expect.closeTo(0.042, 12),
    output: 0,
  });
  const dual = v3.models.find((model) => model.provider === "openrouter" && model.id === "dual");
  expect(dual?.pricing).toMatchObject({ status: "known", input: 9, output: 9 });
  expect(dual?.inference?.decision?.billing).toMatchObject({
    unit: "tokens",
    usdPerMillion: { input: expect.closeTo(0.042, 12), output: 0 },
  });
  expect(
    v2.models.find((model) => model.provider === "openrouter" && model.id === "dual"),
  ).not.toHaveProperty("inference");
  expect(v3.schemaVersion).toBe(3);
  expect(v3).not.toHaveProperty("minVersion");
  const direct = v3.models.find((model) => model.provider === "typesafe" && model.id === "jev");
  const router = v3.models.find(
    (model) => model.provider === "openrouter" && model.id === "typesafe/jev",
  );
  expect(direct?.inference?.decision?.limits).toMatchObject({
    maxRequestTokens: 64000,
    maxStateAndQuestionTokens: 32000,
  });
  expect(direct?.inference?.decision?.limits).not.toHaveProperty("maxInputTokens");
  expect(router?.inference?.decision?.limits?.maxInputTokens).toBe(32000);
  expect(direct?.inference?.chat).toBe(false);
  expect(direct).not.toHaveProperty("headers");
  expect(direct).not.toHaveProperty("baseUrl");
  expect(v3.providers.typesafe).not.toHaveProperty("authScope");
  expect(router?.inference?.decision?.billing).toMatchObject({
    unit: "tokens",
    usdPerMillion: { input: expect.closeTo(0.042, 12), output: 0 },
  });
  expect(v3.models.find((model) => model.id === "typesafe/free")?.pricing).toMatchObject({
    status: "known",
    input: 0,
    output: 0,
  });
  expect(v3.models.find((model) => model.id === "typesafe/mixed-fees")?.pricing.status).toBe(
    "unknown",
  );
  expect(v3.models.find((model) => model.provider === "sage")?.pricing.status).toBe("unknown");
  expect(v3.models.find((model) => model.provider === "anthropic")?.pricing.status).toBe("unknown");
  expect(() => parseRemoteModelCatalogBundleV2({ ...v3, schemaVersion: 2 })).toThrow();
  const projected = projectRemoteModelCatalog(parseRemoteModelCatalogWireBundle(load("v3.json")));
  const normalized = normalizeModelCatalog(
    { providers: projected.providers },
    { ownedProviders: new Set(Object.keys(projected.providers)) },
  );
  expect(normalized?.providers?.typesafe?.models[0]?.inference).toMatchObject({
    chat: false,
    decision: {
      billing: { unit: "tokens", usdPerMillion: { input: expect.closeTo(0.042, 12), output: 0 } },
    },
  });
});

it("does not let native rows hide a truncated legacy chat publication", async () => {
  const root = roots.make("catalog-legacy-floor-");
  const dir = path.join(root, "extensions", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const seeds = Array.from({ length: 99 }, (_, id) => ({ id: "chat-" + id }));
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["anthropic", "openai"],
      modelCatalog: {
        providers: {
          anthropic: { models: [...seeds, { id: "native", inference: inference(32000) }] },
          openai: { models: [...seeds, { id: "last-chat" }] },
        },
      },
    }),
  );
  await expect(
    runPublishModelCatalog({
      rootDir: root,
      sourceCommit: "fixture",
      fetchImpl: async () => {
        throw new Error("unexpected request");
      },
      args: ["--out", "v1.json", "--out-v3", "v3.json"],
    }),
  ).rejects.toThrow("at least 200 chat models");
  expect(fs.existsSync(path.join(root, "v1.json"))).toBe(false);
  expect(fs.existsSync(path.join(root, "v3.json"))).toBe(false);
});

it("keeps a qualified tariff as data without advertising its base as an unconditional native estimate", async () => {
  const bundle = {
    schemaVersion: 1 as const,
    generatedAt: 1,
    sourceCommit: "fixture-tier",
    providers: {
      fixture: {
        models: [
          {
            id: "tiered",
            inference: inference(64000),
            cost: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              tieredPricing: [
                { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, range: [1000] as [number] },
              ],
            },
          },
        ],
      },
    },
  };
  const v3 = await assembleModelCatalogBundleV3(bundle, new WeakMap());
  expect(v3.models[0]?.pricing).toMatchObject({
    status: "known",
    tieredPricing: [{ input: 4, range: [1000] }],
  });
  expect(v3.models[0]?.inference?.decision?.billing).not.toHaveProperty("usdPerMillion");
});

it("does not flatten the decision-only tariff of a dual-task model or replace its chat rate", async () => {
  const model = { id: "dual", inference: { ...inference(32000), chat: true } };
  const bundle = {
    schemaVersion: 1 as const,
    generatedAt: 1,
    sourceCommit: "fixture-dual-tier",
    providers: { openrouter: { models: [model] } },
  };
  await enrichModelCatalogPricing({
    bundle,
    manifests: [
      {
        pluginId: "openrouter",
        manifestPath: "fixture",
        manifest: {
          providers: ["openrouter"],
          modelPricing: {
            providers: {
              openrouter: {
                modelsDev: false,
                liteLLM: false,
                openRouter: { provider: "openrouter" },
              },
            },
          },
        },
      },
    ],
    loadSource: async (url) =>
      url === "https://openrouter.ai/api/v1/models"
        ? { data: [{ id: "dual", pricing: { prompt: "0.000009", completion: "0.000009" } }] }
        : url.includes("output_modalities=decisions")
          ? {
              data: [
                {
                  id: "dual",
                  pricing: {
                    prompt: "0.000001",
                    completion: "0",
                    overrides: [{ min_prompt_tokens: 1000, prompt: "0.000004" }],
                  },
                },
              ],
            }
          : {},
  });
  const v3 = await assembleModelCatalogBundleV3(bundle, new WeakMap());
  expect(v3.models[0]?.pricing).toMatchObject({ status: "known", input: 9, output: 9 });
  expect(v3.models[0]?.inference?.decision?.billing).not.toHaveProperty("usdPerMillion");
});

it("does not replace an unusable native tariff with the same ID's chat tariff", async () => {
  const model = { id: "dual-source", inference: inference(32000) };
  const bundle = {
    schemaVersion: 1 as const,
    generatedAt: 1,
    sourceCommit: "fixture-native-source",
    providers: { openrouter: { models: [model] } },
  };
  await enrichModelCatalogPricing({
    bundle,
    manifests: [
      {
        pluginId: "openrouter",
        manifestPath: "fixture",
        manifest: {
          providers: ["openrouter"],
          modelPricing: {
            providers: {
              openrouter: {
                modelsDev: false,
                liteLLM: false,
                openRouter: { provider: "openrouter" },
              },
            },
          },
        },
      },
    ],
    loadSource: async (url) =>
      url === "https://openrouter.ai/api/v1/models"
        ? { data: [{ id: "dual-source", pricing: { prompt: "0.000009", completion: "0.000009" } }] }
        : url.includes("output_modalities=decisions")
          ? {
              data: [
                {
                  id: "dual-source",
                  pricing: { prompt: "0.000000042", completion: "0", request: "0.1" },
                },
              ],
            }
          : {},
  });
  const v3 = await assembleModelCatalogBundleV3(bundle, new WeakMap());
  expect(v3.models[0]?.pricing.status).toBe("unknown");
  expect(v3.models[0]?.inference?.decision?.billing).not.toHaveProperty("usdPerMillion");
});
