import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import * as manifestModelIdNormalization from "../plugins/manifest-model-id-normalization.js";
import { captureEnv } from "../test-utils/env.js";
import {
  resetUsageFormatCachesForTest,
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

  it("uses the sole agent directory from a canonical roster", async () => {
    const opsAgentDir = path.join(stateDir, "custom-ops-agent");
    await writePricing(opsAgentDir, "demo-roster", [
      pricingModel("demo-model", { input: 42, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ]);
    const config = {
      agents: { entries: { ops: { agentDir: opsAgentDir } } },
    } satisfies OpenClawConfig;

    expect(
      resolveModelCostConfig({ provider: "demo-roster", model: "demo-model", config })?.input,
    ).toBe(42);
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
});
