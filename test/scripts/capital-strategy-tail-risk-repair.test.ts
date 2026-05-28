import { describe, expect, it } from "vitest";
import { buildCapitalStrategyTailRiskRepairPlan } from "../../scripts/openclaw-capital-strategy-tail-risk-repair.mjs";

describe("capital strategy tail risk repair", () => {
  it("keeps tail-risk repair paper-only and rejects sizing-only fixes", () => {
    const result = buildCapitalStrategyTailRiskRepairPlan({
      status: "ok",
      recommendation: "hold",
      promotionGate: {
        status: "blocked",
        blockedReasons: ["tail_risk_positive"],
      },
      tailRiskRepair: {
        status: "blocked_no_positive_tail_candidate",
        currentP05Pts: -4.1,
        currentP05Notional: -8.2,
        selectedSymbols: ["MNQ0000"],
        candidateIntentCount: 3,
        positiveTailCandidateCount: 0,
        evaluatedSubsetCount: 7,
        repairCandidateReplay: {
          schema: "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1",
          status: "candidate_batch_replayed_still_blocked",
          selectedSymbols: ["YM0000", "ES0000"],
          selectedCandidateCount: 2,
          replayCandidate: {
            p05_total_pnl_pts: -16.1,
            p05_total_pnl_notional: -260,
            tailPass: false,
          },
          currentCandidate: {
            p05_total_pnl_pts: -4.1,
            p05_total_pnl_notional: -8.2,
            tailPass: false,
          },
          replayBetterThanCurrent: false,
          followUpCommand: "pnpm capital:trade:current-paper-intents",
          noOrderWrite: true,
          failedReplayHistory: {
            schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
            maxBaskets: 8,
            basketCount: 2,
            baskets: [
              { index: 1, key: "ES0000|YM0000", symbols: ["ES0000", "YM0000"] },
              { index: 2, key: "QM0000", symbols: ["QM0000"] },
            ],
            excludedSymbols: ["ES0000", "QM0000", "YM0000"],
          },
          machineLine:
            "tailRepairReplay=candidate_batch_replayed_still_blocked;selected=YM0000|ES0000;p05=-16.1;p05Notional=-260;betterThanCurrent=false;noOrderWrite=true",
        },
        rejectedIntentDiagnostics: [
          {
            symbol: "MNQ0000",
            intentId: "paper-mnq",
            marketCode: "MNQ",
            side: "buy",
            direction: "long",
            selected: true,
            status: "selected_for_simulation",
            repairAction: "no_repair_required",
            reasons: [],
            currency: "USD",
            riskNotional: 80,
            confidence: 0.605,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
            tailPassFeasibility: {
              modeledLossProbability: 0.313125,
              requiredConfidenceForPositiveP05: 1.306666,
              feasibleWithCurrentConfidence: false,
            },
          },
          {
            symbol: "YM0000",
            intentId: "paper-ym",
            marketCode: "YM",
            side: "buy",
            direction: "long",
            selected: false,
            status: "filtered_by_downside_subset",
            repairAction: "combine_with_low_correlation_candidate_or_reduce_tail_loss",
            reasons: ["downside_tail_filtered"],
            currency: "USD",
            riskPts: 12,
            rewardPts: 24,
            riskNotional: 60,
            rewardNotional: 120,
            confidence: 0.605,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
            tailPassFeasibility: {
              modeledLossProbability: 0.313125,
              requiredConfidenceForPositiveP05: 1.306666,
              feasibleWithCurrentConfidence: false,
            },
          },
          {
            symbol: "ES0000",
            intentId: "paper-es",
            marketCode: "ES",
            side: "buy",
            direction: "long",
            selected: false,
            status: "filtered_by_downside_subset",
            repairAction: "combine_with_low_correlation_candidate_or_reduce_tail_loss",
            reasons: ["downside_tail_filtered"],
            currency: "USD",
            riskPts: 4,
            rewardPts: 8,
            riskNotional: 200,
            rewardNotional: 400,
            confidence: 0.605,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
            tailPassFeasibility: {
              modeledLossProbability: 0.313125,
              requiredConfidenceForPositiveP05: 1.306666,
              feasibleWithCurrentConfidence: false,
            },
          },
          {
            symbol: "QM0000",
            intentId: "paper-qm",
            marketCode: "QM",
            side: "buy",
            direction: "long",
            selected: false,
            status: "filtered_by_downside_subset",
            repairAction: "combine_with_low_correlation_candidate_or_reduce_tail_loss",
            reasons: ["downside_tail_filtered"],
            currency: "USD",
            riskPts: 4,
            rewardPts: 8,
            riskNotional: 120,
            rewardNotional: 240,
            confidence: 0.59,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
            tailPassFeasibility: {
              modeledLossProbability: 0.313125,
              requiredConfidenceForPositiveP05: 1.306666,
              feasibleWithCurrentConfidence: false,
            },
          },
          {
            symbol: "BZ0000",
            intentId: "paper-bz",
            marketCode: "BZ",
            side: "buy",
            direction: "long",
            selected: false,
            status: "filtered_by_downside_subset",
            repairAction: "combine_with_low_correlation_candidate_or_reduce_tail_loss",
            reasons: ["downside_tail_filtered"],
            currency: "USD",
            riskPts: 4,
            rewardPts: 8,
            riskNotional: 150,
            rewardNotional: 300,
            confidence: 0.585,
            routeReady: true,
            resolverReady: true,
            historicalSnapshot: false,
            paperExplorationOnly: false,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
            tailPassFeasibility: {
              modeledLossProbability: 0.313125,
              requiredConfidenceForPositiveP05: 1.306666,
              feasibleWithCurrentConfidence: false,
            },
          },
        ],
        tailPassFeasibility: {
          empiricalTailEvidence: {
            status: "blocked_stop_hit_rate_over_tail_threshold",
            evidenceMode: "paper_simulated_outcomes",
            liveCalibrationAllowed: false,
            noLiveOrderSent: true,
            outcomeStats: {
              sampleCount: 70,
              stopHitRate: 0.510204,
              simulatedOnly: true,
            },
          },
          selectedDiagnostics: [
            {
              symbol: "MNQ0000",
              intentId: "paper-mnq",
              confidence: 0.605,
              tailPassFeasibility: {
                modeledLossProbability: 0.313125,
                requiredConfidenceForPositiveP05: 1.306666,
              },
            },
          ],
        },
      },
    });
    const sameCaseRerunEvidence =
      result.repairCandidatePlan.nextPaperCandidateBatch.sameCaseRerunEvidence;

    expect(result.status).toBe("blocked_no_effective_repair_ready");
    expect(result.safetyLock).toMatchObject({
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    });
    expect(result.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sizing_only_repair", status: "ineffective" }),
        expect.objectContaining({
          id: "wait_for_stronger_signal_confidence",
          status: "blocked_current_signal_cannot_pass",
        }),
      ]),
    );
    expect(result.machineLine).toContain("noOrderWrite=true");
    expect(result.nextCommand).toMatchObject({
      command: "pnpm capital:trade:current-paper-intents",
      validationCommand: "pnpm capital:trade:current-paper-intents:check",
      followUpCommand: "pnpm capital:strategy:fill-simulation:check",
      noOrderWrite: true,
    });
    expect(result.machineLine).toContain("nextCommand=pnpm capital:trade:current-paper-intents");
    expect(result.machineLine).toContain("nextPaperCandidateBatch=ready_to_refresh_and_rerun");
    expect(result.machineLine).toContain(
      "validationCommand=pnpm capital:trade:current-paper-intents:check",
    );
    expect(result.machineLine).toContain("stopHitRate=0.510204");
    expect(result.machineLine).toContain("requiredConfidence=1.306666");
    expect(result.repairCandidatePlan.nextPaperCandidateBatch).toMatchObject({
      schema: "openclaw.capital.strategy-tail-risk-next-paper-candidate-batch.v1",
      status: "ready_to_refresh_and_rerun",
      selectedSymbols: ["BZ0000"],
      excludedFailedReplaySymbols: ["ES0000", "QM0000", "YM0000"],
      skippedFailedReplayCandidateCount: 3,
      availableAfterExclusionCount: 1,
      followUpCommand: "pnpm capital:strategy:fill-simulation:check",
      noOrderWrite: true,
      safetyLock: {
        writeBrokerOrders: false,
        sentOrder: false,
        noLiveOrderSent: true,
      },
    });
    expect(
      result.repairCandidatePlan.nextPaperCandidateBatch.candidateQualityEvidence,
    ).toMatchObject({
      schema: "openclaw.capital.strategy-tail-risk-candidate-quality-evidence.v1",
      status: "candidate_quality_ready_for_rerun",
      selectedCandidateCount: 1,
      freshResolvedCount: 1,
      knownPointValueCount: 1,
      oppositeExposureCount: 0,
      crossGroupProxyCount: 1,
      replayTailPass: false,
      noOrderWrite: true,
      safetyLock: {
        writeBrokerOrders: false,
        sentOrder: false,
        noLiveOrderSent: true,
      },
    });
    expect(sameCaseRerunEvidence).toMatchObject({
      schema: "openclaw.capital.strategy-tail-risk-same-case-rerun-evidence.v1",
      status: "ready_for_next_same_case_rerun",
      currentP05Pts: -4.1,
      currentP05Notional: -8.2,
      followUpCommand: "pnpm capital:strategy:fill-simulation:check",
      replayOutcome: {
        schema: "openclaw.capital.strategy-tail-risk-rerun-outcome.v1",
        status: "candidate_batch_replayed_still_blocked",
        replayP05Pts: -16.1,
        replayP05Notional: -260,
        replayTailPass: false,
        currentP05Pts: -4.1,
        currentP05Notional: -8.2,
        replayBetterThanCurrent: false,
        failedReplayHistory: {
          schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
          excludedSymbols: ["ES0000", "QM0000", "YM0000"],
        },
        noOrderWrite: true,
      },
      noOrderWrite: true,
      safetyLock: {
        writeBrokerOrders: false,
        sentOrder: false,
        noLiveOrderSent: true,
      },
    });
    expect(sameCaseRerunEvidence.candidateContributionRanking).toMatchObject([
      {
        rank: 1,
        symbol: "BZ0000",
        p05DragProxyNotional: -150,
        requiresSameCaseRerun: true,
      },
    ]);
    expect(result.repairCandidatePlan.nextPaperCandidateBatch.machineLine).toContain(
      "excludedFailedReplay=ES0000|QM0000|YM0000",
    );
    expect(result.repairCandidatePlan.nextPaperCandidateBatch.machineLine).toContain(
      "sameCaseRerunEvidence=ready_for_next_same_case_rerun",
    );
    expect(result.repairCandidatePlan.nextPaperCandidateBatch.machineLine).toContain(
      "candidateQualityEvidence=candidate_quality_ready_for_rerun",
    );
    expect(result.repairCandidatePlan.nextPaperCandidateBatch.machineLine).toContain(
      "replayOutcome=candidate_batch_replayed_still_blocked",
    );
  });

  it("keeps failed replay history exclusion when no new replay candidates remain", () => {
    const result = buildCapitalStrategyTailRiskRepairPlan({
      status: "ok",
      recommendation: "hold",
      promotionGate: {
        status: "blocked",
        blockedReasons: ["tail_risk_positive"],
      },
      tailRiskRepair: {
        status: "blocked_no_positive_tail_candidate",
        currentP05Pts: -4.1,
        currentP05Notional: -8.2,
        selectedSymbols: ["MNQ0000"],
        repairCandidateReplay: {
          schema: "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1",
          status: "blocked_no_new_repair_candidates_after_failed_replay",
          selectedSymbols: [],
          selectedCandidateCount: 0,
          replayBetterThanCurrent: false,
          noOrderWrite: true,
          failedReplayHistory: {
            schema: "openclaw.capital.strategy-tail-risk-failed-replay-history.v1",
            maxBaskets: 8,
            basketCount: 1,
            baskets: [{ index: 1, key: "ES0000|YM0000", symbols: ["ES0000", "YM0000"] }],
            excludedSymbols: ["ES0000", "YM0000"],
          },
        },
        rejectedIntentDiagnostics: [
          {
            symbol: "MNQ0000",
            intentId: "paper-mnq",
            marketCode: "MNQ",
            direction: "long",
            selected: true,
            status: "selected_for_simulation",
            repairAction: "no_repair_required",
            reasons: [],
            currency: "USD",
            riskNotional: 80,
            confidence: 0.605,
            sourceFreshnessStatus: "fresh",
            pointValueConfidence: "medium",
          },
          {
            symbol: "YM0000",
            intentId: "paper-ym",
            marketCode: "YM",
            direction: "long",
            selected: false,
            status: "filtered_by_downside_subset",
            repairAction: "combine_with_low_correlation_candidate_or_reduce_tail_loss",
            reasons: ["downside_tail_filtered"],
            currency: "USD",
            riskPts: 12,
            riskNotional: 60,
            confidence: 0.605,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
          },
          {
            symbol: "ES0000",
            intentId: "paper-es",
            marketCode: "ES",
            direction: "long",
            selected: false,
            status: "filtered_by_downside_subset",
            repairAction: "combine_with_low_correlation_candidate_or_reduce_tail_loss",
            reasons: ["downside_tail_filtered"],
            currency: "USD",
            riskPts: 4,
            riskNotional: 200,
            confidence: 0.605,
            sourceFreshnessStatus: "fresh",
            sourceWallClockAgeSeconds: 1,
            pointValueConfidence: "medium",
          },
        ],
        tailPassFeasibility: {
          empiricalTailEvidence: {
            status: "blocked_stop_hit_rate_over_tail_threshold",
            noLiveOrderSent: true,
            outcomeStats: { sampleCount: 70, stopHitRate: 0.51 },
          },
          selectedDiagnostics: [{ symbol: "MNQ0000", intentId: "paper-mnq", confidence: 0.605 }],
        },
      },
    });

    const batch = result.repairCandidatePlan.nextPaperCandidateBatch;
    expect(batch).toMatchObject({
      status: "blocked_no_candidate_batch",
      selectedSymbols: [],
      excludedFailedReplaySymbols: ["ES0000", "YM0000"],
      skippedFailedReplayCandidateCount: 2,
      availableAfterExclusionCount: 0,
      noOrderWrite: true,
    });
    expect(batch.sameCaseRerunEvidence).toMatchObject({
      status: "blocked_no_candidates",
      followUpCommand: "pnpm capital:strategy:fill-simulation:check",
    });
    expect(batch.machineLine).toContain("excludedFailedReplay=ES0000|YM0000");
  });
});
