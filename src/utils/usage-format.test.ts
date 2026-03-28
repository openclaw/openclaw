import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __resetGatewayModelPricingCacheForTest,
  __setGatewayModelPricingForTest,
} from "../gateway/model-pricing-cache-state.js";
import {
  __resetUsageFormatCachesForTest,
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
} from "./usage-format.js";

describe("usage-format", () => {
  const originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-format-"));
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    __resetUsageFormatCachesForTest();
    __resetGatewayModelPricingCacheForTest();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = originalAgentDir;
    }
    __resetUsageFormatCachesForTest();
    __resetGatewayModelPricingCacheForTest();
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(999_499)).toBe("999k");
    expect(formatTokenCount(999_500)).toBe("1.0m");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = {
      models: {
        providers: {
          test: {
            models: [
              {
                id: "m1",
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

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

  it("returns undefined when model pricing is not configured", () => {
    expect(
      resolveModelCostConfig({
        provider: "demo-unconfigured-a",
        model: "demo-model-a",
      }),
    ).toBeUndefined();

    expect(
      resolveModelCostConfig({
        provider: "demo-unconfigured-b",
        model: "demo-model-b",
      }),
    ).toBeUndefined();
  });

  it("prefers models.json pricing over openclaw config and cached pricing", async () => {
    const config = {
      models: {
        providers: {
          "demo-preferred": {
            models: [
              {
                id: "demo-model",
                cost: { input: 20, output: 21, cacheRead: 22, cacheWrite: 23 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            "demo-preferred": {
              models: [
                {
                  id: "demo-model",
                  cost: { input: 10, output: 11, cacheRead: 12, cacheWrite: 13 },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    __setGatewayModelPricingForTest([
      {
        provider: "demo-preferred",
        model: "demo-model",
        pricing: { input: 30, output: 31, cacheRead: 32, cacheWrite: 33 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-preferred",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 10,
      output: 11,
      cacheRead: 12,
      cacheWrite: 13,
    });
  });

  it("falls back to openclaw config pricing when models.json is absent", () => {
    const config = {
      models: {
        providers: {
          "demo-config-provider": {
            models: [
              {
                id: "demo-model",
                cost: { input: 9, output: 19, cacheRead: 0.9, cacheWrite: 1.9 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    __setGatewayModelPricingForTest([
      {
        provider: "demo-config-provider",
        model: "demo-model",
        pricing: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-config-provider",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 9,
      output: 19,
      cacheRead: 0.9,
      cacheWrite: 1.9,
    });
  });

  it("falls back to cached gateway pricing when no configured cost exists", () => {
    __setGatewayModelPricingForTest([
      {
        provider: "demo-cached-provider",
        model: "demo-model",
        pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-cached-provider",
        model: "demo-model",
      }),
    ).toEqual({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
    });
  });
});
