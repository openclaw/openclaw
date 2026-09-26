import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeModelCatalog } from "../../packages/model-catalog-core/src/model-catalog-normalize.js";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  validateAndSanitizeRemoteModelCatalogBundleV3,
} from "../../packages/model-catalog-core/src/remote-catalog-bundle.js";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
it("publishes real pinned TypeSafe facts while leaving aliases/local prices unknown and legacy chat feeds safe", async () => {
  const root = roots.make("typesafe-catalog-");
  const dir = path.join(root, "extensions", "typesafe");
  fs.mkdirSync(dir, { recursive: true });
  const source = fs.readFileSync(
    new URL("../../extensions/typesafe/openclaw.plugin.json", import.meta.url),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), source);
  const seeds = Array.from({ length: 100 }, (_, i) => ({ id: "seed-" + i }));
  const seedDir = path.join(root, "extensions", "seeds");
  fs.mkdirSync(seedDir);
  fs.writeFileSync(
    path.join(seedDir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["anthropic", "openai"],
      modelCatalog: { providers: { anthropic: { models: seeds }, openai: { models: seeds } } },
    }),
  );
  const v1 = path.join(root, "v1.json"),
    v2 = path.join(root, "v2.json"),
    v3 = path.join(root, "v3.json");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runPublishModelCatalog({
    rootDir: root,
    sourceCommit: "typesafe-documentation-snapshot",
    now: () => 1234,
    args: ["--pricing", "--out", v1, "--out-v2", v2, "--out-v3", v3],
    fetchImpl: async (url) =>
      Response.json(
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes(
          "openrouter.ai",
        )
          ? {
              data: [
                {
                  id: "typesafe/jev-latest",
                  pricing: { prompt: "0.000099", completion: "0.000099" },
                },
              ],
            }
          : {},
      ),
  });
  const legacy = parseRemoteModelCatalogBundle(JSON.parse(fs.readFileSync(v1, "utf8")));
  const second = parseRemoteModelCatalogBundleV2(JSON.parse(fs.readFileSync(v2, "utf8")));
  const third = validateAndSanitizeRemoteModelCatalogBundleV3(
    JSON.parse(fs.readFileSync(v3, "utf8")),
  );
  expect(legacy.providers.typesafe).toBeUndefined();
  expect(second.models.some((m) => m.provider === "typesafe")).toBe(false);
  const model = third.models.find((m) => m.provider === "typesafe" && m.id === "jev-1.13.0");
  expect(model).toMatchObject({
    pricing: { status: "known", input: 0.042, output: 0, source: "provider-docs" },
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
  expect(model).not.toHaveProperty("baseUrl");
  expect(legacy.pricing?.["typesafe/jev-1.13.0"]).toMatchObject({ input: 0.042, output: 0 });
  expect(second.providerPricing?.["typesafe/jev-1.13.0"]).toMatchObject({
    input: 0.042,
    output: 0,
  });
  for (const id of ["jev-latest", "kev-latest"]) {
    const row = third.models.find((m) => m.provider === "typesafe" && m.id === id);
    expect(row?.pricing.status).toBe("unknown");
    expect(row?.inference?.decision?.billing).toBeUndefined();
    expect(row?.inference?.decision?.limits).toBeUndefined();
    expect(legacy.pricing?.["typesafe/" + id]).toBeUndefined();
  }
  const manifest = JSON.parse(source);
  const normalized = normalizeModelCatalog(manifest.modelCatalog, {
    ownedProviders: new Set<string>(manifest.providers),
  });
  expect(normalized?.providers?.typesafe?.authScope).toBe("plugin");
  expect(normalized?.providers?.typesafe?.models.find((m) => m.id === "jev-1.13.0")?.baseUrl).toBe(
    "https://api.typesafe.ai/v1/systemone",
  );
});
