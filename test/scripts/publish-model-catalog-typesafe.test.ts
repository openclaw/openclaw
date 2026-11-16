import fs from "node:fs";
import path from "node:path";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
} from "@openclaw/model-catalog-core";
import {
  LITELLM_PRICING_URL,
  MODELS_DEV_CATALOG_URL,
  OPENROUTER_MODELS_URL,
} from "@openclaw/model-catalog-core/model-catalog-pricing";
import { afterEach, expect, it, vi } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps TypeSafe native models and borrowed prices out of released catalogs", async () => {
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
  const files = [path.join(rootDir, "v1.json"), path.join(rootDir, "v2.json")] as const;
  const ids = ["jev-1.13.0", "jev-latest", "jev-preview", "kev-latest"];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await expect(
    runPublishModelCatalog({
      rootDir,
      sourceCommit: "typesafe-documentation-snapshot",
      now: () => 1234,
      args: ["--pricing", "--out", files[0], "--out-v2", files[1]],
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
  expect(legacy.providers).not.toHaveProperty("typesafe");
  expect(second.providers).not.toHaveProperty("typesafe");
  expect(second.models).toHaveLength(200);
  for (const id of ids) {
    expect(legacy.pricing?.[`typesafe/${id}`]).toBeUndefined();
    expect(second.providerPricing?.[`typesafe/${id}`]).toBeUndefined();
  }
});
