import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStrategyFillSimulation } from "../../scripts/openclaw-capital-strategy-fill-simulator.mjs";

describe("capital strategy fill source selection", () => {
  it("prefers generated current target-registry intents over direct probe primary intents", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-fill-source-"));
    const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
    await fs.mkdir(tradingRoot, { recursive: true });
    const primaryPath = path.join(tradingRoot, "capital-paper-intents.jsonl");
    const generatedPath = path.join(
      tradingRoot,
      "capital-current-paper-intents-from-target-registry.jsonl",
    );

    await fs.writeFile(
      primaryPath,
      `${JSON.stringify({
        schema: "openclaw.capital.paper-intent.v1",
        intentId: "direct-cn-probe",
        symbol: "CN0000",
        provider: "capital",
        paperOnly: true,
        executionEligible: true,
        writeBrokerOrders: false,
      })}\n`,
      "utf8",
    );
    await fs.writeFile(
      generatedPath,
      `${JSON.stringify({
        schema: "openclaw.capital.paper-intent.v2",
        intentId: "generated-nq-intent",
        intentRunId: "capital-current-paper-intents-test",
        source: "target_registry_current_paper_intents",
        symbol: "NQ0000",
        strategy: "capital_trend_following_fresh_quote_probe",
        riskPts: 4,
        rewardPts: 8,
        confidence: 0.61,
        pointValue: 20,
        pointValueCurrency: "USD",
        qty: 1,
        paperOnly: true,
        executionEligible: true,
        resolverReady: true,
        routeReady: true,
        historicalSnapshot: false,
        promotionBlocked: false,
        paperExplorationOnly: false,
        allowLiveTrading: false,
        liveTradingEnabled: false,
        writeBrokerOrders: false,
        writeTradingEnabled: false,
        brokerOrderPathEnabled: false,
        promoteLiveAuto: false,
        promoteLiveAutomatically: false,
      })}\n`,
      "utf8",
    );

    const result = await runStrategyFillSimulation({ repoRoot });

    expect(result.source).toMatchObject({
      sourceKind: "generated_current",
      fallbackUsed: true,
      fallbackReason: "primary_superseded_by_generated_current",
    });
    expect(result.tailRiskRepair.selectedSymbols).toEqual(["NQ0000"]);
  });
});
