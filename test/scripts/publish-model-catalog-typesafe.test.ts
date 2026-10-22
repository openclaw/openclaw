import fs from "node:fs";
import path from "node:path";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  parseRemoteModelCatalogBundleV3,
} from "@openclaw/model-catalog-core";
import {
  LITELLM_PRICING_URL,
  MODELS_DEV_CATALOG_URL,
  OPENROUTER_MODELS_URL,
} from "@openclaw/model-catalog-core/model-catalog-pricing";
import { afterEach, expect, it, vi } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { finalizePluginModelUsage } from "../../src/plugins/runtime/runtime-model-usage.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("publishes pinned TypeSafe billing without borrowing prices for aliases or local models", async () => {
  const rootDir = roots.make("typesafe-catalog-");
  const pluginDir = path.join(rootDir, "extensions", "typesafe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(
    new URL("../../extensions/typesafe/openclaw.plugin.json", import.meta.url),
    path.join(pluginDir, "openclaw.plugin.json"),
  );
  const loaded = loadPluginManifest(pluginDir);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  expect(
    loaded.manifest.modelCatalog?.providers?.typesafe?.models.find(
      (model) => model.id === "jev-1.13.0",
    ),
  ).toMatchObject({
    baseUrl: "https://api.typesafe.ai/v1",
    inference: { chat: false, decision: { protocol: "typesafe-systemone" } },
  });

  // Keep the publisher's released chat-catalog floor; native rows cannot satisfy it.
  const seedDir = path.join(rootDir, "extensions", "seeds");
  fs.mkdirSync(seedDir);
  const seeds = Array.from({ length: 100 }, (_, index) => ({ id: `seed-${index}` }));
  fs.writeFileSync(
    path.join(seedDir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["anthropic", "openai"],
      modelCatalog: {
        providers: { anthropic: { models: seeds }, openai: { models: seeds } },
      },
    }),
  );
  fs.mkdirSync(path.join(rootDir, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "scripts", "lib", "recommended-models.json"), "[]");
  const files = [
    path.join(rootDir, "v1.json"),
    path.join(rootDir, "v2.json"),
    path.join(rootDir, "v3.json"),
  ] as const;
  const ids = ["jev-1.13.0", "jev-latest", "jev-preview", "kev-latest"];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(
    runPublishModelCatalog({
      rootDir,
      sourceCommit: "typesafe-documentation-snapshot",
      now: () => 1234,
      args: ["--pricing", "--out", files[0], "--out-v2", files[1], "--out-v3", files[2]],
      fetchImpl: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === MODELS_DEV_CATALOG_URL) {
          return Response.json({
            typesafe: {
              models: Object.fromEntries(
                ids.map((id) => [id, { id, cost: { input: 99, output: 99 } }]),
              ),
            },
          });
        }
        if (url === LITELLM_PRICING_URL) {
          return Response.json(
            Object.fromEntries(
              ids.map((id) => [
                `typesafe/${id}`,
                { input_cost_per_token: 0.000099, output_cost_per_token: 0.000099 },
              ]),
            ),
          );
        }
        if (url === OPENROUTER_MODELS_URL) {
          return Response.json({ data: [] });
        }
        throw new Error(`Unexpected catalog source: ${url}`);
      },
    }),
  ).resolves.toMatchObject({ wrote: true });

  const payloads = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const legacy = parseRemoteModelCatalogBundle(payloads[0]);
  const second = parseRemoteModelCatalogBundleV2(payloads[1]);
  const third = parseRemoteModelCatalogBundleV3(payloads[2]);
  expect(legacy.providers).not.toHaveProperty("typesafe");
  expect(second.providers).not.toHaveProperty("typesafe");
  expect(second.models).toHaveLength(200);
  const models = third.models.filter((model) => model.provider === "typesafe");
  expect(models.map((model) => model.id).toSorted()).toEqual(ids.toSorted());
  const pinned = models.find((model) => model.id === "jev-1.13.0");
  expect(pinned).toMatchObject({
    inference: {
      chat: false,
      decision: {
        limits: { maxRequestTokens: 64000, maxStateAndQuestionTokens: 32000 },
        billing: {
          unit: "tokens",
          source: "provider-docs",
          usdPerMillion: { input: 0.042, output: 0 },
        },
      },
    },
  });
  expect(models.find((model) => model.id === "jev-preview")?.status).toBe("preview");
  for (const model of models) {
    expect(model).not.toHaveProperty("baseUrl");
    expect(model).not.toHaveProperty("headers");
    expect(model.inference?.chat).toBe(false);
    // Native billing stays in inference; generic chat prices remain undeclared.
    expect(model.pricing).toEqual({ status: "unknown" });
    expect(legacy.pricing?.[`typesafe/${model.id}`]).toBeUndefined();
    expect(second.providerPricing?.[`typesafe/${model.id}`]).toBeUndefined();
    if (model.id !== "jev-1.13.0") {
      expect(model.inference?.decision).not.toHaveProperty("billing");
      expect(model.inference?.decision).not.toHaveProperty("limits");
    }
    const usage = finalizePluginModelUsage({
      cfg: {},
      estimate: "none",
      suppressUsage: true,
      target: { provider: "typesafe", model: model.id },
      preparedBilling: {
        provider: "typesafe",
        model: model.id,
        billing: model.inference?.decision?.billing,
      },
      rawUsage: { inputTokens: 100, outputTokens: 12 },
    });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(12);
    if (model.id === "jev-1.13.0") {
      expect(usage.costUsd).toBeCloseTo(0.0000042, 12);
    } else {
      expect(usage.costUsd).toBeUndefined();
    }
  }
});
