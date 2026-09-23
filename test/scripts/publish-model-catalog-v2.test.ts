import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  type RemoteModelCatalogBundle,
} from "@openclaw/model-catalog-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleModelCatalogBundleV2,
  parsePublishModelCatalogArgs,
  runPublishModelCatalog,
  serializeModelCatalogBundle,
  serializeModelCatalogBundleV2,
} from "../../scripts/publish-model-catalog.mts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-v2-"));
  roots.push(root);
  const dir = path.join(root, "extensions", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const seeds = Array.from({ length: 100 }, (_, index) => ({ id: `seed-${index}` }));
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["anthropic", "openai", "fixture-native"],
      modelCatalog: {
        modelsDev: { "fixture-native": "upstream" },
        providers: {
          anthropic: {
            models: seeds.map((model, index) =>
              index === 0 ? { ...model, cost: { input: 0.5 } } : model,
            ),
          },
          openai: { defaultModel: "seed-0", models: seeds },
          "fixture-native": {
            models: [
              { id: "free", cost: { input: 9, output: 9 } },
              { id: "paid" },
              { id: "withdrawn", cost: { input: 8, output: 8 } },
            ],
          },
        },
      },
      modelPricing: { providers: { "fixture-native": { openCode: { provider: "upstream" } } } },
    }),
  );
  return root;
}

function fixtureFetch() {
  return vi.fn<typeof fetch>(async (url) => {
    if (url === "https://models.opencode.ai/api.json") {
      return Response.json({
        upstream: {
          id: "upstream",
          models: {
            free: { id: "free", cost: { input: 0, output: 0 } },
            paid: { id: "paid", cost: { input: 2, output: 3 } },
            extra: { id: "extra", cost: { input: 5, output: 6 } },
          },
        },
      });
    }
    return Response.json({ data: [] });
  });
}

describe("publish model catalog v2", () => {
  it("adds an explicit second output while keeping --out as v1", () => {
    expect(parsePublishModelCatalogArgs(["--out", "v1.json", "--out-v2", "v2.json"])).toEqual({
      dryRun: false,
      pricing: false,
      out: "v1.json",
      outV2: "v2.json",
    });
    expect(() => parsePublishModelCatalogArgs(["--out-v2", "v2.json"])).toThrow("provide --out");
    expect(() => parsePublishModelCatalogArgs(["--out", "v1.json", "--out-v2"])).toThrow(
      "requires a value",
    );
  });

  it("projects only metadata rows with partial costs, tiers, and native tuple identity", async () => {
    const bundle: RemoteModelCatalogBundle = {
      schemaVersion: 1,
      generatedAt: 1,
      sourceCommit: "fixture",
      minVersion: "2026.7.0",
      providers: {
        alpha: {
          models: [
            { id: "vendor/model", cost: { input: 2 } },
            { id: "zero", cost: { input: 0, output: 0 } },
            {
              id: "tier",
              cost: {
                tieredPricing: [{ input: 3, output: 4, cacheRead: 0, cacheWrite: 0, range: [0] }],
              },
            },
          ],
        },
        beta: { models: [{ id: "vendor/model" }] },
      },
      pricing: { "alpha/extra": { input: 9, output: 9 } },
    };
    const before = serializeModelCatalogBundle(bundle);
    const v2 = await assembleModelCatalogBundleV2(bundle, new WeakMap());
    expect(v2.models).toHaveLength(4);
    expect(v2.models[0]).toMatchObject({
      id: "vendor/model",
      provider: "alpha",
      pricing: { status: "known", input: 2 },
    });
    expect(v2.models[0]?.pricing).not.toHaveProperty("source");
    expect(v2.models[0]?.pricing).not.toHaveProperty("output");
    expect(v2.models[1]?.pricing).toEqual({ status: "unknown" });
    expect(v2.models[2]?.pricing).toMatchObject({
      status: "known",
      tieredPricing: bundle.providers.alpha?.models[2]?.cost?.tieredPricing,
    });
    expect(v2.models[3]).toMatchObject({
      id: "vendor/model",
      provider: "beta",
      pricing: { status: "unknown" },
    });
    expect(v2).not.toHaveProperty("pricing");
    expect(v2).not.toHaveProperty("minVersion");
    expect(serializeModelCatalogBundle(bundle)).toBe(before);
    const serialized = serializeModelCatalogBundleV2(v2);
    const parsed = parseRemoteModelCatalogBundleV2(JSON.parse(serialized));
    expect(parsed.models).toHaveLength(4);
    expect(Object.keys(JSON.parse(serialized).models[0]).slice(0, 2)).toEqual(["id", "provider"]);
    expect(serializeModelCatalogBundleV2({ ...v2, models: v2.models.toReversed() })).toBe(
      serialized,
    );
  });

  it("writes paired catalogs from one source snapshot, preserving authoritative zero and withdrawal", async () => {
    const rootDir = fixtureRoot();
    const fetchImpl = fixtureFetch();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runPublishModelCatalog({
      rootDir,
      fetchImpl,
      now: () => 42,
      sourceCommit: "fixture",
      args: ["--pricing", "--out", "v1/catalog.json", "--out-v2", "v2/catalog.json"],
    });
    const v1 = parseRemoteModelCatalogBundle(
      JSON.parse(fs.readFileSync(path.join(rootDir, "v1/catalog.json"), "utf8")),
    );
    const v2 = parseRemoteModelCatalogBundleV2(
      JSON.parse(fs.readFileSync(path.join(rootDir, "v2/catalog.json"), "utf8")),
    );
    expect(v1.generatedAt).toBe(v2.generatedAt);
    expect(v1.sourceCommit).toBe(v2.sourceCommit);
    expect(v1.minVersion).toBe("2026.7.0");
    expect(v2.models).toHaveLength(203);
    expect(v2.providers.openai?.defaultModel).toBe("seed-0");
    expect(
      v2.models.find((model) => model.provider === "anthropic" && model.id === "seed-0")?.pricing,
    ).toEqual({
      status: "known",
      currency: "USD",
      unit: "million_tokens",
      input: 0.5,
      source: "manifest",
    });
    expect(v2.models.find((model) => model.id === "free")?.pricing).toMatchObject({
      status: "known",
      input: 0,
      output: 0,
      source: "openCode",
    });
    expect(v2.models.find((model) => model.id === "paid")?.pricing).toMatchObject({
      status: "known",
      input: 2,
      output: 3,
      source: "openCode",
    });
    expect(v2.models.find((model) => model.id === "withdrawn")?.pricing).toEqual({
      status: "unavailable",
      source: "openCode",
    });
    expect(v1.pricing?.["fixture-native/extra"]).toBeDefined();
    expect(v2.models.some((model) => model.id === "extra")).toBe(false);
    expect(
      fetchImpl.mock.calls.filter(([url]) => url === "https://models.opencode.ai/api.json"),
    ).toHaveLength(1);
    await runPublishModelCatalog({
      rootDir,
      fetchImpl: fixtureFetch(),
      now: () => 42,
      sourceCommit: "fixture",
      args: ["--pricing", "--out", "v1-only.json"],
    });
    expect(fs.readFileSync(path.join(rootDir, "v1-only.json"), "utf8")).toBe(
      fs.readFileSync(path.join(rootDir, "v1/catalog.json"), "utf8"),
    );
  });

  it("keeps both prior files on source failure and never writes in dry-run mode", async () => {
    const rootDir = fixtureRoot();
    const out = path.join(rootDir, "v1.json");
    const outV2 = path.join(rootDir, "v2.json");
    fs.writeFileSync(out, "previous v1");
    fs.writeFileSync(outV2, "previous v2");
    const args = ["--pricing", "--out", out, "--out-v2", outV2];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      runPublishModelCatalog({
        rootDir,
        sourceCommit: "fixture",
        args,
        fetchImpl: async () => {
          throw new Error("fixture outage");
        },
      }),
    ).rejects.toThrow("fixture outage");
    await runPublishModelCatalog({
      rootDir,
      sourceCommit: "fixture",
      args: [...args, "--dry-run"],
      fetchImpl: fixtureFetch(),
    });
    expect(fs.readFileSync(out, "utf8")).toBe("previous v1");
    expect(fs.readFileSync(outV2, "utf8")).toBe("previous v2");
    await expect(
      runPublishModelCatalog({ rootDir, args: ["--out", "same.json", "--out-v2", "./same.json"] }),
    ).rejects.toThrow("different files");
  });
});
