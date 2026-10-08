import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import * as manifestModelIdNormalization from "../plugins/manifest-model-id-normalization.js";
import { captureEnv } from "../test-utils/env.js";
import {
  resetUsageFormatCachesForTest,
  estimateUsageCost,
  formatUsd,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "./usage-format.js";

type ModelCostConfig = NonNullable<ReturnType<typeof resolveModelCostConfig>>;

function pricingModel(id: string, cost: ModelDefinitionConfig["cost"]): ModelDefinitionConfig {
  return { id, name: id, reasoning: false, input: ["text"], maxTokens: 1, cost };
}

function pricingConfig(provider: string, models: ModelDefinitionConfig[]): OpenClawConfig {
  return {
    models: { providers: { [provider]: { baseUrl: "https://fixture.invalid", models } } },
  };
}

async function writePricing(
  agentDir: string,
  provider: string,
  models: ModelDefinitionConfig[],
): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify(pricingConfig(provider, models).models),
    "utf8",
  );
}

describe("usage-format", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let agentDir: string;
  let stateDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-format-"));
    agentDir = path.join(stateDir, "agents", "main", "agent");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_AGENT_DIR;
    await fs.mkdir(agentDir, { recursive: true });
    resetUsageFormatCachesForTest();
  });

  afterEach(async () => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    resetUsageFormatCachesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = pricingConfig("test", [
      pricingModel("m1", { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }),
    ]);

    const cost = resolveModelCostConfig({
      provider: "test",
      model: "m1",
      config,
    });

    expect(cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
    });

    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });

    expect(total).toBeCloseTo(0.003);
  });

  it("prefers explicit configured pricing over a provider-owned static model price", () => {
    const config = pricingConfig("openai", [
      pricingModel("gpt-5.4", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(
      resolveModelCostConfig({
        provider: "openai",
        model: "gpt-5.4",
        config,
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("prefers agent-local pricing over configured and provider-owned static model prices", async () => {
    const config = pricingConfig("openai", [
      pricingModel("gpt-5.4", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
    ]);
    await writePricing(agentDir, "openai", [
      pricingModel("gpt-5.4", { input: 7, output: 11, cacheRead: 0.5, cacheWrite: 0.25 }),
    ]);

    expect(
      resolveModelCostConfig({
        provider: "openai",
        model: "gpt-5.4",
        config,
      }),
    ).toEqual({ input: 7, output: 11, cacheRead: 0.5, cacheWrite: 0.25 });
  });

  it("scopes models.json pricing by agent directory before configured and default pricing", async () => {
    const secondAgentDir = path.join(stateDir, "agents", "second", "agent");
    const configuredOnlyAgentDir = path.join(stateDir, "agents", "configured-only", "agent");
    await writePricing(agentDir, "demo-scoped", [
      pricingModel("demo-model", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    await writePricing(secondAgentDir, "demo-scoped", [
      pricingModel("demo-model", { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    await fs.mkdir(configuredOnlyAgentDir, { recursive: true });

    const config = pricingConfig("demo-scoped", [
      pricingModel("demo-model", { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const resolveInputPrice = (scopedAgentDir?: string) =>
      resolveModelCostConfig({
        provider: "demo-scoped",
        model: "demo-model",
        config,
        agentDir: scopedAgentDir,
      })?.input;

    expect(resolveInputPrice(agentDir)).toBe(10);
    expect(resolveInputPrice(secondAgentDir)).toBe(20);
    expect(resolveInputPrice(configuredOnlyAgentDir)).toBe(30);
    expect(resolveInputPrice()).toBe(10);
  });

  it("bounds the agent-directory models.json pricing cache", async () => {
    const agentDirs = Array.from({ length: 129 }, (_, index) =>
      path.join(stateDir, "agents", `bounded-${index}`, "agent"),
    );
    for (const [index, targetAgentDir] of agentDirs.entries()) {
      await writePricing(targetAgentDir, "demo-bounded", [
        pricingModel("demo-model", { input: index + 1, output: 0, cacheRead: 0, cacheWrite: 0 }),
      ]);
      expect(
        resolveModelCostConfig({
          provider: "demo-bounded",
          model: "demo-model",
          agentDir: targetAgentDir,
        })?.input,
      ).toBe(index + 1);
    }

    const firstAgentDir = expectDefined(agentDirs[0], "first bounded agent directory");
    await writePricing(firstAgentDir, "demo-bounded", [
      pricingModel("demo-model", { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    expect(
      resolveModelCostConfig({
        provider: "demo-bounded",
        model: "demo-model",
        agentDir: firstAgentDir,
      })?.input,
    ).toBe(999);
  });

  it("skips manifest model normalization for raw cost lookup", () => {
    const manifestSpy = vi.spyOn(
      manifestModelIdNormalization,
      "resolveManifestModelIdNormalizationPolicies",
    );
    const config = pricingConfig("demo-raw", [
      pricingModel("demo-model", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-raw",
        model: "demo-model",
        config,
        allowPluginNormalization: false,
      }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
    expect(
      resolveModelCostConfig({
        provider: "anthropic",
        model: "missing-model",
        config,
        allowPluginNormalization: false,
      }),
    ).toBeUndefined();
    expect(manifestSpy).not.toHaveBeenCalled();
  });

  const firstRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
  const laterRates = { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 };
  const laterTiers = [{ ...laterRates, range: [0, Infinity] as [number, number] }];
  it.each([
    { name: "full", cost: firstRates, expected: firstRates },
    { name: "partial", cost: { output: 0 }, expected: { ...laterRates, output: 0 } },
    {
      name: "zero",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { name: "empty", cost: {}, expected: { ...laterRates, tieredPricing: laterTiers } },
    { name: "omitted", cost: undefined, expected: { ...laterRates, tieredPricing: laterTiers } },
    { name: "empty tiers", cost: { tieredPricing: [] }, expected: laterRates },
    {
      name: "authored tiers",
      cost: { tieredPricing: [{ ...firstRates, range: [0] }] },
      expected: {
        ...laterRates,
        tieredPricing: [{ ...firstRates, range: [0, Infinity] }],
      },
    },
  ])("merges duplicate model rows with first-authored $name cost", ({ cost, expected }) => {
    const config = {
      models: {
        providers: {
          venice: {
            models: [
              { id: "priced-fixture", cost },
              { id: "priced-fixture", cost: { ...laterRates, tieredPricing: laterTiers } },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "venice", model: "priced-fixture" }),
    ).toEqual(expected);
  });

  it("refreshes duplicate model prices and fingerprints after ordered source mutations", () => {
    type SourceModel = { id: string; cost?: Partial<ModelDefinitionConfig["cost"]> };
    const first: SourceModel = { id: "priced-fixture", cost: { ...firstRates } };
    const later: SourceModel = { id: "priced-fixture", cost: { ...laterRates } };
    const models = [first, later];
    const config = {
      models: { providers: { venice: { models } } },
    } as unknown as OpenClawConfig;
    let previousFingerprint: string | undefined;
    const check = (label: string, expected: ModelCostConfig | undefined) => {
      expect
        .soft(
          resolveModelCostConfig({ config, agentDir, provider: "venice", model: "priced-fixture" }),
          label,
        )
        .toEqual(expected);
      const fingerprint = resolveModelCostConfigFingerprint(config, agentDir);
      expect.soft(fingerprint, label).not.toBe(previousFingerprint);
      previousFingerprint = fingerprint;
      // Fingerprinting refreshes the full index; it must agree with direct lookups.
      expect
        .soft(
          resolveModelCostConfig({ config, agentDir, provider: "venice", model: "priced-fixture" }),
          label,
        )
        .toEqual(expected);
    };
    check("initial duplicates", firstRates);
    first.cost!.input = 9;
    check("mutated first cost", { ...firstRates, input: 9 });
    delete first.cost;
    check("removed first cost", laterRates);
    first.cost = { output: 0 };
    check("restored partial cost", { ...laterRates, output: 0 });
    const inserted = { id: "priced-fixture", cost: { ...firstRates, input: 3 } };
    models.unshift(inserted);
    check("inserted duplicate", inserted.cost);
    models.reverse();
    check("reordered duplicates", laterRates);
    models[0] = { id: "priced-fixture", cost: { ...firstRates, input: 4 } };
    check("replaced same-id row", { ...firstRates, input: 4 });
    models.shift();
    check("removed duplicate", { ...inserted.cost, output: 0 });
    models.splice(0);
    check("removed all rows", undefined);
  });

  it.each(["canonical first", "canonical last", "aliases only"])(
    "selects the canonical provider price owner with %s",
    (order) => {
      const canonical = { models: [{ id: "priced-fixture", cost: firstRates }] };
      const alias = { models: [{ id: "priced-fixture", cost: laterRates }] };
      const providers =
        order === "canonical first"
          ? { venice: canonical, " VENICE ": alias }
          : order === "canonical last"
            ? { " VENICE ": alias, venice: canonical }
            : { " Venice ": alias, " VENICE ": canonical };
      const config = { models: { providers } } as unknown as OpenClawConfig;
      expect(
        resolveModelCostConfig({ config, agentDir, provider: "venice", model: "priced-fixture" }),
      ).toEqual(firstRates);
    },
  );

  it("preserves explicit models.json precedence while merging its duplicate rows and provider keys", async () => {
    const config = pricingConfig("venice", [pricingModel("priced-fixture", laterRates)]);
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          venice: {
            models: [
              { id: "priced-fixture", cost: { output: 0 } },
              { id: "priced-fixture", cost: firstRates },
            ],
          },
          " VENICE ": { models: [{ id: "priced-fixture", cost: laterRates }] },
        },
      }),
    );
    expect(
      resolveModelCostConfig({ config, agentDir, provider: "venice", model: "priced-fixture" }),
    ).toEqual({ ...firstRates, output: 0 });
  });

  it("observes structural config pricing changes after a cached lookup", () => {
    const models = [
      pricingModel("demo-model", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    ];
    const config = pricingConfig("demo-structural", models);

    expect(
      resolveModelCostConfig({
        provider: "demo-structural",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(1);

    models.push(pricingModel("new-model", { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }));
    expect(
      resolveModelCostConfig({
        provider: "demo-structural",
        model: "new-model",
        config,
      })?.input,
    ).toBe(5);

    models.splice(0, 1);
    expect(
      resolveModelCostConfig({
        provider: "demo-structural",
        model: "demo-model",
        config,
      }),
    ).toBeUndefined();
  });

  it("ignores malformed raw tier ranges while caching config pricing", () => {
    const config = {
      models: {
        providers: {
          "demo-bad-tier": {
            models: [
              {
                id: "demo-model",
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 3,
                  cacheWrite: 4,
                  tieredPricing: [
                    { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, range: undefined },
                  ],
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-bad-tier",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
  });

  it("skips metadata-only model rows while caching configured pricing", async () => {
    const metadataOnlyModel = { id: "metadata-only" } as {
      id: string;
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
    const config = {
      models: {
        providers: {
          "demo-metadata-row": {
            models: [
              metadataOnlyModel,
              {
                id: "priced-model",
                cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-row",
        model: "metadata-only",
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-row",
        model: "priced-model",
        config,
      })?.input,
    ).toBe(1);

    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-row",
        model: "metadata-only",
        config,
      })?.input,
    ).toBe(9);

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-metadata-json": {
            models: [
              { id: "metadata-only" },
              {
                id: "priced-model",
                cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-json",
        model: "priced-model",
      })?.input,
    ).toBe(5);
  });

  it("updates pricing fingerprints when metadata-only model rows gain pricing", () => {
    const metadataOnlyModel = { id: "metadata-only" } as {
      id: string;
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
    const config = {
      models: {
        providers: {
          "demo-metadata-fingerprint": {
            models: [metadataOnlyModel],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const before = resolveModelCostConfigFingerprint(config);
    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    const after = resolveModelCostConfigFingerprint(config);

    expect(before).toMatch(/^[0-9a-f]{64}$/u);
    expect(after).toMatch(/^[0-9a-f]{64}$/u);
    expect(after).not.toBe(before);
    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-fingerprint",
        model: "metadata-only",
        config,
      })?.input,
    ).toBe(9);
  });

  it("retries models.json after an initial missing read", async () => {
    expect(
      resolveModelCostConfig({
        provider: "demo-late",
        model: "demo-model",
      }),
    ).toBeUndefined();

    await writePricing(agentDir, "demo-late", [
      pricingModel("demo-model", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-late",
        model: "demo-model",
      })?.input,
    ).toBe(1);
  });

  it("does not poll models.json stats after the process-local cost index is loaded", async () => {
    await writePricing(agentDir, "demo-stat", [
      pricingModel("demo-model", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-stat",
        model: "demo-model",
      })?.input,
    ).toBe(1);

    const statSpy = vi.spyOn(nodeFs, "statSync");
    try {
      for (let i = 0; i < 20; i += 1) {
        expect(
          resolveModelCostConfig({
            provider: "demo-stat",
            model: "demo-model",
          })?.input,
        ).toBe(1);
      }
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
  });

  it("normalizes open-ended range from models.json ([start] and [start, -1])", async () => {
    const baseRates = { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0 };
    const extendedRates = { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0 };
    await writePricing(agentDir, "volcengine", [
      pricingModel("doubao-open-ended", {
        ...baseRates,
        tieredPricing: [
          { ...baseRates, range: [0, 32000] },
          { ...extendedRates, range: [32000] },
        ],
      }),
      pricingModel("doubao-neg-one", {
        ...baseRates,
        tieredPricing: [
          { ...baseRates, range: [0, 32000] },
          { ...extendedRates, range: [32000, -1] },
        ],
      }),
    ]);

    // [32000] should be normalized to [32000, Infinity]
    const cost1 = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-open-ended",
    });
    const tiers1 = expectDefined(cost1?.tieredPricing, "open-ended tiered pricing");
    expect(tiers1).toHaveLength(2);
    expect(expectDefined(tiers1[1], "tiers1[1] test invariant").range).toEqual([32000, Infinity]);

    // [32000, -1] should also be normalized to [32000, Infinity]
    const cost2 = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-neg-one",
    });
    const tiers2 = expectDefined(cost2?.tieredPricing, "negative-end tiered pricing");
    expect(tiers2).toHaveLength(2);
    expect(expectDefined(tiers2[1], "tiers2[1] test invariant").range).toEqual([32000, Infinity]);
  });

  it("resolves tiered pricing from models.json", async () => {
    await writePricing(agentDir, "volcengine", [
      pricingModel("doubao-seed-2-0-pro", {
        input: 0.46,
        output: 2.3,
        cacheRead: 0,
        cacheWrite: 0,
        tieredPricing: [
          { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
          { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32000, 128000] },
        ],
      }),
    ]);

    const cost = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-seed-2-0-pro",
    });
    const tiers = expectDefined(cost?.tieredPricing, "models.json tiered pricing");

    expect(tiers).toHaveLength(2);
    expect(expectDefined(tiers[0], "tiers[0] test invariant").range).toEqual([0, 32000]);
    expect(expectDefined(tiers[1], "tiers[1] test invariant").input).toBe(0.7);
  });
});
