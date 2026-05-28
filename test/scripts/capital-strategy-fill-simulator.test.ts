import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStrategyFillSimulation } from "../../scripts/openclaw-capital-strategy-fill-simulator.mjs";

describe("capital strategy fill simulator", () => {
  it("keeps fallback strategy intents in historical snapshot safety lock", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-strategy-fill-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      await fs.writeFile(path.join(tradingDir, "capital-paper-intents.jsonl"), "", "utf8");
      await fs.writeFile(
        path.join(tradingDir, "capital-strategy-intents.jsonl"),
        `${JSON.stringify({
          schema: "openclaw.capital.paper-intent.v2",
          intentId: "fallback-strategy-intent",
          symbol: "TX00",
          strategy: "orb_long",
          riskPts: 10,
          rewardPts: 20,
          confidence: 0.6,
          paperOnly: true,
          executionEligible: true,
          historicalSnapshot: false,
          promotionBlocked: false,
          allowLiveTrading: false,
          writeBrokerOrders: false,
          promoteLiveAuto: false,
        })}\n`,
        "utf8",
      );

      const result = await runStrategyFillSimulation({
        repoRoot: tmpDir,
        monteCarloIterations: 3,
      });

      expect(result.status).toBe("historical_simulated");
      expect(result.recommendation).toBe("hold");
      expect(result.source).toMatchObject({
        fallbackUsed: true,
        simulationMode: "historical_snapshot",
      });
      expect(result.safetyLock).toMatchObject({
        executionEligible: false,
        promotionBlocked: true,
        historicalSnapshot: true,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses Monte Carlo fill and win evidence while keeping negative tail risk blocked", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-strategy-fill-current-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-intents.jsonl"),
        [
          {
            schema: "openclaw.capital.paper-intent.v2",
            intentId: "current-paper-ap0000",
            symbol: "AP0000",
            strategy: "capital_trend_following_fresh_quote_probe",
            riskPts: 4,
            rewardPts: 8,
            pointValue: 25,
            pointValueCurrency: "AUD",
            riskNotional: 100,
            rewardNotional: 200,
            confidence: 0.59,
            riskRewardRatio: 2,
            paperOnly: true,
            executionEligible: true,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            promotionBlocked: false,
            allowLiveTrading: false,
            writeBrokerOrders: false,
            promoteLiveAuto: false,
          },
          {
            schema: "openclaw.capital.paper-intent.v2",
            intentId: "current-paper-nq0000-high-risk",
            symbol: "NQ0000",
            strategy: "capital_trend_following_fresh_quote_probe",
            riskPts: 50,
            rewardPts: 100,
            pointValue: 20,
            pointValueCurrency: "USD",
            riskNotional: 10000,
            rewardNotional: 20000,
            confidence: 0.6,
            riskRewardRatio: 2,
            paperOnly: true,
            executionEligible: true,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            promotionBlocked: false,
            allowLiveTrading: false,
            writeBrokerOrders: false,
            promoteLiveAuto: false,
          },
        ]
          .map((intent) => JSON.stringify(intent))
          .join("\n") + "\n",
        "utf8",
      );

      const result = await runStrategyFillSimulation({
        repoRoot: tmpDir,
        monteCarloIterations: 200,
      });

      expect(result.status).toBe("ok");
      expect(result.stats.evidence_fill_rate).toBeGreaterThanOrEqual(0.5);
      expect(result.stats.evidence_win_rate).toBeGreaterThanOrEqual(0.48);
      expect(result.promotionGate.blockedReasons).not.toContain("fill_rate_threshold");
      expect(result.promotionGate.blockedReasons).not.toContain("win_rate_threshold");
      expect(result.promotionGate.blockedReasons).toContain("tail_risk_positive");
      expect(result.tailRiskRepair).toMatchObject({
        schema: "openclaw.capital.strategy-tail-risk-repair.v1",
        status: "blocked_no_positive_tail_candidate",
        blocker: "tail_risk_positive",
      });
      expect(result.tailRiskRepair.repairCandidatePlan).toMatchObject({
        schema: "openclaw.capital.strategy-tail-risk-repair-candidate-plan.v1",
        status: "blocked_selected_intents_need_tail_evidence",
        safetyLock: {
          paperOnly: true,
          noLiveOrderSent: true,
          writeBrokerOrders: false,
        },
        sameCaseRerun: {
          command: "pnpm capital:strategy:fill-simulation:check",
          noLiveOrderSent: true,
        },
      });
      expect(
        result.tailRiskRepair.repairCandidatePlan.selectedNeedsConfidence.length,
      ).toBeGreaterThan(0);
      expect(
        result.tailRiskRepair.repairCandidatePlan.overMaxRiskCandidates.some((candidate) =>
          candidate.reasons.includes("over_max_risk"),
        ),
      ).toBe(true);
      expect(result.tailRiskRepair.repairCandidatePlan.machineLine).toContain("noOrderWrite=true");
      expect(result.tailRiskRepair.repairCandidateReplay).toMatchObject({
        schema: "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1",
        noOrderWrite: true,
        safetyLock: {
          writeBrokerOrders: false,
          noLiveOrderSent: true,
        },
      });
      expect(result.tailRiskRepair.repairCandidateReplay.machineLine).toContain(
        "noOrderWrite=true",
      );
      expect(result.stats.risk_filter.actionableRepairCandidates.length).toBeGreaterThan(0);
      expect(
        result.stats.risk_filter.actionableRepairCandidates.some((candidate) =>
          candidate.reasons.includes("over_max_risk"),
        ),
      ).toBe(true);
      expect(result.tailRiskRepair.tailPassFeasibility).toMatchObject({
        model: "current_paper_tail_pass_feasibility_v1",
        empiricalCalibrationStatus: "blocked_learning_registry_missing",
        sizingOnlyRepairCanPass: false,
        noLiveOrderSent: true,
      });
      expect(result.empiricalTailEvidence).toMatchObject({
        schema: "openclaw.capital.strategy-tail-empirical-evidence.v1",
        status: "blocked_learning_registry_missing",
        canCalibrateTailFeasibility: false,
        noLiveOrderSent: true,
      });
      expect(result.tailRiskRepair.tailPassFeasibility.infeasibleSelectedCount).toBeGreaterThan(0);
      expect(
        result.tailRiskRepair.tailPassFeasibility.selectedDiagnostics.some(
          (diagnostic) => diagnostic.tailPassFeasibility.requiredConfidenceForPositiveP05 > 1,
        ),
      ).toBe(true);
      expect(result.tailRiskRepair.machineLine).toContain("noOrderWrite=true");
      expect(result.tailRiskRepair.machineLine).toContain("repairReplay=");
      expect(result.recommendation).toBe("hold");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes empirical tail evidence only when outcome samples are sufficient", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-strategy-fill-evidence-"));
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
          counters: {
            totalCycles: 120,
            paperIntents: 90,
            readinessBlocks: 0,
            consecutiveReadyCycles: 90,
            consecutiveReadinessBlocks: 0,
          },
          outcomeStats: {
            sampleCount: 80,
            stopHitCount: 3,
            takeProfitHitCount: 77,
            stopHitRate: 0.0375,
            winRate: 0.9625,
          },
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-intents.jsonl"),
        `${JSON.stringify({
          schema: "openclaw.capital.paper-intent.v2",
          intentId: "current-paper-mes0000",
          symbol: "MES0000",
          strategy: "capital_trend_following_fresh_quote_probe",
          riskPts: 4,
          rewardPts: 8,
          pointValue: 5,
          pointValueCurrency: "USD",
          riskNotional: 20,
          rewardNotional: 40,
          confidence: 0.59,
          riskRewardRatio: 2,
          paperOnly: true,
          executionEligible: true,
          routeReady: true,
          resolverReady: true,
          historicalSnapshot: false,
          paperExplorationOnly: false,
          promotionBlocked: false,
          allowLiveTrading: false,
          writeBrokerOrders: false,
          promoteLiveAuto: false,
        })}\n`,
        "utf8",
      );

      const result = await runStrategyFillSimulation({
        repoRoot: tmpDir,
        monteCarloIterations: 200,
      });

      expect(result.empiricalTailEvidence).toMatchObject({
        status: "ready_for_empirical_tail_calibration",
        canCalibrateTailFeasibility: true,
        noLiveOrderSent: true,
      });
      expect(result.tailRiskRepair.tailPassFeasibility).toMatchObject({
        empiricalCalibrationStatus: "ready_for_empirical_tail_calibration",
        empiricalCalibrationCanPass: true,
      });
      expect(result.recommendation).toBe("hold");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("allows paper promotion only when explicit paper tail controls make p05 positive", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-strategy-fill-tail-control-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-intents.jsonl"),
        [
          {
            schema: "openclaw.capital.paper-intent.v2",
            intentId: "current-paper-mgc0000-tail-control",
            symbol: "MGC0000",
            strategy: "capital_mean_reversion_fresh_quote_probe",
            riskPts: 4,
            rewardPts: 8,
            pointValue: 10,
            pointValueCurrency: "USD",
            riskNotional: 40,
            rewardNotional: 80,
            confidence: 0.605,
            riskRewardRatio: 2,
            paperOnly: true,
            executionEligible: true,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            promotionBlocked: false,
            allowLiveTrading: false,
            liveTradingEnabled: false,
            writeBrokerOrders: false,
            writeTradingEnabled: false,
            brokerOrderPathEnabled: false,
            promoteLiveAuto: false,
            promoteLiveAutomatically: false,
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
            schema: "openclaw.capital.paper-intent.v2",
            intentId: "current-paper-es0000-no-tail-control",
            symbol: "ES0000",
            strategy: "capital_mean_reversion_fresh_quote_probe",
            riskPts: 2,
            rewardPts: 4,
            pointValue: 50,
            pointValueCurrency: "USD",
            riskNotional: 100,
            rewardNotional: 200,
            confidence: 0.62,
            riskRewardRatio: 2,
            paperOnly: true,
            executionEligible: true,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            promotionBlocked: false,
            allowLiveTrading: false,
            writeBrokerOrders: false,
            promoteLiveAuto: false,
          },
        ]
          .map((intent) => JSON.stringify(intent))
          .join("\n") + "\n",
        "utf8",
      );

      const result = await runStrategyFillSimulation({
        repoRoot: tmpDir,
        monteCarloIterations: 200,
      });

      expect(result.recommendation).toBe("promote");
      expect(result.promotionGate).toMatchObject({
        status: "ready_for_paper_promotion",
        paperPromotionEligible: true,
        noLiveOrderSent: true,
      });
      expect(result.monteCarlo.p05_total_pnl_pts).toBeGreaterThan(0);
      expect(result.monteCarlo.p05_total_pnl_notional).toBeGreaterThan(0);
      expect(result.stats.risk_filter.downsideFilter.tailPass).toBe(true);
      expect(result.stats.risk_filter.tailControlFilteredIntentCount).toBe(1);
      expect(result.tailRiskRepair).toMatchObject({
        status: "tail_risk_passed",
        safetyLock: {
          writeBrokerOrders: false,
          noLiveOrderSent: true,
        },
      });
      expect(result.tailRiskRepair.tailPassFeasibility.infeasibleSelectedCount).toBe(0);
      expect(
        result.tailRiskRepair.tailPassFeasibility.selectedDiagnostics[0].tailPassFeasibility
          .tailRiskControls.model,
      ).toBe("breakeven_time_stop_trailing_target_paper_v1");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("excludes the previous failed replay basket from the next repair replay", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-strategy-fill-replay-"));
    try {
      const tradingDir = path.join(tmpDir, ".openclaw", "trading");
      await fs.mkdir(tradingDir, { recursive: true });
      await fs.writeFile(
        path.join(tradingDir, "capital-strategy-fill-simulation.json"),
        `${JSON.stringify({
          tailRiskRepair: {
            repairCandidateReplay: {
              status: "candidate_batch_replayed_still_blocked",
              replayBetterThanCurrent: false,
              selectedSymbols: ["ES0000"],
              failedReplayHistory: {
                schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
                maxBaskets: 8,
                basketCount: 1,
                baskets: [{ index: 1, key: "NQ0000", symbols: ["NQ0000"] }],
                excludedSymbols: ["NQ0000"],
              },
            },
          },
        })}\n`,
        "utf8",
      );

      const baseIntent = {
        schema: "openclaw.capital.paper-intent.v2",
        strategy: "capital_trend_following_fresh_quote_probe",
        rewardPts: 8,
        pointValue: 5,
        pointValueCurrency: "USD",
        confidence: 0.59,
        riskRewardRatio: 2,
        paperOnly: true,
        executionEligible: true,
        routeReady: true,
        resolverReady: true,
        historicalSnapshot: false,
        paperExplorationOnly: false,
        promotionBlocked: false,
        allowLiveTrading: false,
        writeBrokerOrders: false,
        promoteLiveAuto: false,
      };
      await fs.writeFile(
        path.join(tradingDir, "capital-paper-intents.jsonl"),
        [
          {
            ...baseIntent,
            intentId: "current-paper-ap0000",
            symbol: "AP0000",
            riskPts: 4,
            riskNotional: 20,
            rewardNotional: 40,
          },
          {
            ...baseIntent,
            intentId: "current-paper-nq0000",
            symbol: "NQ0000",
            riskPts: 12,
            riskNotional: 60,
            rewardNotional: 120,
          },
          {
            ...baseIntent,
            intentId: "current-paper-es0000",
            symbol: "ES0000",
            riskPts: 12,
            riskNotional: 80,
            rewardNotional: 160,
          },
          {
            ...baseIntent,
            intentId: "current-paper-qm0000",
            symbol: "QM0000",
            riskPts: 4,
            riskNotional: 120,
            rewardNotional: 240,
          },
        ]
          .map((intent) => JSON.stringify(intent))
          .join("\n") + "\n",
        "utf8",
      );

      const result = await runStrategyFillSimulation({
        repoRoot: tmpDir,
        monteCarloIterations: 50,
      });

      expect(result.tailRiskRepair.repairCandidateReplay).toMatchObject({
        status: "candidate_batch_replayed_still_blocked",
        selectedSymbols: ["AP0000"],
        excludedFailedReplaySymbols: ["ES0000", "NQ0000"],
        skippedFailedReplayCandidateCount: 2,
        availableAfterExclusionCount: 1,
        failedReplayHistory: {
          schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
          basketCount: 3,
          excludedSymbols: ["AP0000", "ES0000", "NQ0000"],
        },
        noOrderWrite: true,
      });
      expect(result.tailRiskRepair.repairCandidateReplay.selectedSymbols).not.toContain("NQ0000");
      expect(result.tailRiskRepair.repairCandidateReplay.selectedSymbols).not.toContain("ES0000");
      expect(result.tailRiskRepair.repairCandidateReplay.machineLine).toContain(
        "excludedFailedReplay=ES0000|NQ0000",
      );
      expect(result.tailRiskRepair.repairCandidateReplay.machineLine).toContain(
        "failedReplayHistoryCount=3",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
