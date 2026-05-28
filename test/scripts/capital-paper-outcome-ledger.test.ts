import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCapitalPaperOutcomeLedger } from "../../scripts/openclaw-capital-paper-outcome-ledger.mjs";

describe("capital paper outcome ledger", () => {
  it("writes deterministic paper-only outcomes and updates the learning registry", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-outcome-ledger-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-learning-registry.json"),
        `${JSON.stringify({
          schema: "openclaw.capital.paper-learning-registry.v1",
          strategyName: "capital-paper-microstructure-probe",
          status: "approved_paper",
          liveEligible: false,
          paperEligible: true,
          counters: { totalCycles: 1, paperIntents: 1 },
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-intents.jsonl"),
        `${JSON.stringify({
          schema: "openclaw.capital.paper-intent.v2",
          intentId: "current-paper-mnq0000",
          intentRunId: "run-1",
          symbol: "MNQ0000",
          strategy: "capital_trend_following_fresh_quote_probe",
          side: "buy",
          qty: 1,
          entryPrice: 100,
          stopPrice: 98,
          takeProfit: 104,
          riskPts: 2,
          rewardPts: 4,
          pointValue: 2,
          pointValueCurrency: "USD",
          confidence: 0.6,
          paperOnly: true,
          executionEligible: true,
          routeReady: true,
          resolverReady: true,
          historicalSnapshot: false,
          promotionBlocked: false,
          allowLiveTrading: false,
          writeBrokerOrders: false,
          promoteLiveAuto: false,
        })}\n`,
        "utf8",
      );

      const result = await runCapitalPaperOutcomeLedger({
        repoRoot: tmpDir,
        scenariosPerIntent: 12,
      });

      expect(result.status).toBe("ok");
      expect(result.stats.sampleCount).toBe(12);
      expect(result.stats.filledCount).toBe(
        result.stats.stopHitCount + result.stats.takeProfitHitCount,
      );
      expect(result.learningRegistryUpdated).toBe(true);
      expect(result.learningRegistry?.outcomeStats).toMatchObject({
        sampleCount: 12,
        paperOnly: true,
        simulatedOnly: true,
        noLiveOrderSent: true,
      });
      expect(result).toMatchObject({
        paperOnly: true,
        simulatedOnly: true,
        allowLiveTrading: false,
        writeBrokerOrders: false,
        noLiveOrderSent: true,
      });
      await expect(
        fs.stat(path.join(tradingDir, "capital-paper-outcome-ledger-latest.json")),
      ).resolves.toBeTruthy();
      await expect(
        fs.stat(path.join(tradingDir, "capital-paper-outcome-ledger.jsonl")),
      ).resolves.toBeTruthy();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefers generated-current intents over single active loop intents", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-outcome-ledger-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-intents.jsonl"),
        `${JSON.stringify({
          schema: "openclaw.capital.paper-intent.v2",
          intentId: "active-loop-cn0000",
          intentRunId: "capital-paper-loop",
          source: "capital-paper-automation-loop",
          symbol: "CN0000",
          strategy: "capital-paper-microstructure-probe",
          side: "buy",
          qty: 1,
          entryPrice: 100,
          riskPts: 1,
          rewardPts: 1,
          pointValue: 1,
          confidence: 0.55,
          paperOnly: true,
          allowLiveTrading: false,
          writeBrokerOrders: false,
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(tradingDir, "capital-current-paper-intents-from-target-registry.jsonl"),
        [
          {
            schema: "openclaw.capital.paper-intent.v2",
            intentId: "generated-current-es0000",
            intentRunId: "capital-current-paper-intents-test",
            source: "target_registry_current_paper_intents",
            symbol: "ES0000",
            strategy: "capital_breakout_fresh_quote_probe",
            side: "buy",
            qty: 1,
            entryPrice: 100,
            riskPts: 2,
            rewardPts: 4,
            pointValue: 50,
            confidence: 0.57,
            paperOnly: true,
            executionEligible: true,
            allowLiveTrading: false,
            writeBrokerOrders: false,
          },
          {
            schema: "openclaw.capital.paper-intent.v2",
            intentId: "generated-current-mcl0000",
            intentRunId: "capital-current-paper-intents-test",
            source: "target_registry_current_paper_intents",
            symbol: "MCL0000",
            strategy: "capital_breakout_fresh_quote_probe",
            side: "buy",
            qty: 1,
            entryPrice: 100,
            riskPts: 2,
            rewardPts: 4,
            pointValue: 100,
            confidence: 0.57,
            paperOnly: true,
            executionEligible: true,
            allowLiveTrading: false,
            writeBrokerOrders: false,
          },
        ]
          .map((intent) => JSON.stringify(intent))
          .join("\n") + "\n",
        "utf8",
      );

      const result = await runCapitalPaperOutcomeLedger({
        repoRoot: tmpDir,
        scenariosPerIntent: 3,
      });

      expect(result.status).toBe("ok");
      expect(result.source.sourceKind).toBe("generated_current");
      expect(result.source.fallbackReason).toBe("primary_superseded_by_generated_current");
      expect(result.source.sourceRecordCount).toBe(2);
      expect(result.source.symbols).toEqual(["ES0000", "MCL0000"]);
      expect(result.stats.sampleCount).toBe(6);
      expect(result.noLiveOrderSent).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses only explicit paper tail controls when updating tail outcome evidence", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-outcome-ledger-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      const baseIntent = {
        schema: "openclaw.capital.paper-intent.v2",
        intentRunId: "capital-current-paper-intents-test",
        source: "target_registry_current_paper_intents",
        strategy: "capital_tail_positive_probe",
        side: "buy",
        qty: 1,
        entryPrice: 100,
        riskPts: 2,
        rewardPts: 4,
        pointValue: 10,
        confidence: 0.61,
        paperOnly: true,
        executionEligible: true,
        allowLiveTrading: false,
        writeBrokerOrders: false,
      };
      await fs.writeFile(
        path.join(tradingDir, "capital-current-paper-intents-from-target-registry.jsonl"),
        [
          {
            ...baseIntent,
            intentId: "generated-current-mgc0000-tail-control",
            symbol: "MGC0000",
            meta: {
              noLiveOrderSent: true,
              tailRiskControls: {
                schema: "openclaw.capital.paper-tail-risk-controls.v1",
                status: "enabled",
                model: "breakeven_time_stop_trailing_target_paper_v1",
                enabled: true,
                fillRateAssumption: 0.99,
                stopToScratchRate: 0.98,
                minPositiveExitPts: 0.2,
                simulationOnly: true,
                paperOnly: true,
                noLiveOrderSent: true,
              },
            },
          },
          {
            ...baseIntent,
            intentId: "generated-current-es0000-no-tail-control",
            symbol: "ES0000",
          },
        ]
          .map((intent) => JSON.stringify(intent))
          .join("\n") + "\n",
        "utf8",
      );

      const result = await runCapitalPaperOutcomeLedger({
        repoRoot: tmpDir,
        scenariosPerIntent: 12,
      });

      expect(result.status).toBe("ok");
      expect(result.source.parsedIntentCount).toBe(2);
      expect(result.source.simulationIntentCount).toBe(1);
      expect(result.source.simulationSymbols).toEqual(["MGC0000"]);
      expect(result.stats.sampleCount).toBe(12);
      expect(result.stats.tailControlFilteredIntentCount).toBe(1);
      expect(result.noLiveOrderSent).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
