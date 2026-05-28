import { describe, expect, it } from "vitest";
import { buildCapitalLiveReadinessReport } from "../../scripts/openclaw-capital-live-readiness-gate.mjs";

const baseRepoRoot = "D:/OpenClaw";

describe("capital live readiness gate", () => {
  it("keeps live readiness blocked when strategy or adapter gates are incomplete", () => {
    const report = buildCapitalLiveReadinessReport({
      repoRoot: baseRepoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      platform: {
        status: "blocked_paper_strategy_not_promoted",
        blockers: ["strategy_fill:hold", "adapter:ack_missing"],
        quote: {
          overallFreshness: "multi_target_fresh",
          strategyQuoteReady: true,
          a50: { status: "stale" },
          multiTarget: { status: "fresh", freshPaperTargetCount: 3 },
        },
        strategy: {
          strategyFill: { recommendation: "hold", promotionGate: { status: "blocked" } },
          strategyTailRiskRepair: { status: "blocked_no_effective_repair_ready" },
        },
        positionDecision: { usable: true },
        externalBrokerAdapter: {
          ack: {
            status: "blocked",
            usable: false,
            requiredSealedIntentSha256: "ABC123",
          },
        },
        execution: {
          sealedOrderIntentSha256: "ABC123",
          positionDecision: { status: "verified_flat_no_exit_required" },
        },
        safety: { sentOrder: false, noLiveOrderSent: true },
      },
      direct: {
        status: "live_order_dry_run_pretrade_blocked",
        decision: "quarantine_only_do_not_send",
        preTradeRiskGate: { allowedToSend: false, blockers: ["risk:negative-p05-pnl"] },
        safety: { sentOrder: false, noLiveOrderSent: true },
      },
      adapterAckGate: {
        schema: "openclaw.capital.external-broker-adapter-ack-gate.v1",
        status: "blocked",
        machineLine: "capitalAdapterAck=blocked hashOk=false noOrderWrite=true sentOrder=false",
        blockers: ["ack:sealed-intent-hash-match"],
        ack: {
          hashOk: false,
          canaryPass: true,
          rollbackPass: true,
          requiredTemplatePath:
            "D:/OpenClaw/.openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
        },
        operatorReview: {
          refreshPlan: {
            status: "operator_refresh_required",
            reason: "active_ack_hash_mismatch",
            sourcePath:
              "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
            destinationPath:
              "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
            expectedSealedIntentSha256: "ABC123",
            actualSealedIntentSha256: "OLD123",
            candidateSealedIntentSha256: "ABC123",
            candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
            safeToPromoteCandidate: true,
            activeAckWriteSuppressed: true,
            conversationAgentsMayWriteActiveAck: false,
            allowedWriter: "operator-owned-broker-adapter-only",
            validationCommand: "pnpm capital:trade:adapter-ack:check",
            postRefreshValidationCommand: "pnpm capital:live-readiness:check",
          },
        },
      },
      promotion: {
        status: "blocked",
        readyForManualReview: false,
        blockerCode: "LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED",
        blockers: ["live:paper-promotion-approved"],
      },
      operator: {
        status: "live_disabled",
        riskControls: { enabledAfter: false, allowLiveTrading: false, writeBrokerOrders: false },
        safety: { sentOrder: false },
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("strategy:paper-promoted");
    expect(report.blockers).toContain("adapter:ack-usable");
    expect(report.blockers).toContain("direct:pretrade-allowed");
    expect(report.safety.noLiveOrderSent).toBe(true);
    expect(report.safety.writeBrokerOrders).toBe(false);
    expect(report.machineLine).toContain("noOrderWrite=true");
    expect(report.machineLine).toContain("hashOk=false");
    expect(report.readiness.quote.overallFreshness).toBe("multi_target_fresh");
    expect(report.readiness.externalBrokerAdapter.ackGateStatus).toBe("blocked");
    expect(report.readiness.externalBrokerAdapter.hashOk).toBe(false);
    expect(report.readiness.externalBrokerAdapter.refreshPlan).toMatchObject({
      status: "operator_refresh_required",
      reason: "active_ack_hash_mismatch",
      safeToPromoteCandidate: true,
      candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
      validationCommand: "pnpm capital:trade:adapter-ack:check",
      postRefreshValidationCommand: "pnpm capital:live-readiness:check",
    });
  });

  it("treats direct pretrade as pass when only safety-only blockers remain", () => {
    const report = buildCapitalLiveReadinessReport({
      repoRoot: baseRepoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      platform: {
        status: "blocked_live_promotion_required",
        blockers: ["adapter:ack_missing"],
        quote: {
          overallFreshness: "multi_target_fresh",
          strategyQuoteReady: true,
          a50: { status: "stale" },
          multiTarget: { status: "fresh", freshPaperTargetCount: 3 },
        },
        strategy: {
          strategyFill: { recommendation: "promote", promotionGate: { status: "ready" } },
          strategyTailRiskRepair: { status: "tail_risk_passed" },
        },
        positionDecision: { usable: true },
        externalBrokerAdapter: {
          ack: {
            status: "blocked",
            usable: false,
            requiredSealedIntentSha256: "ABC123",
          },
        },
        execution: {
          sealedOrderIntentSha256: "ABC123",
          positionDecision: { status: "verified_open_position_manual_exit_review" },
        },
        safety: { sentOrder: false, noLiveOrderSent: true },
      },
      direct: {
        status: "live_order_dry_run_pretrade_blocked",
        decision: "quarantine_only_do_not_send",
        preTradeRiskGate: {
          attachedBeforeBrokerSend: true,
          evaluated: true,
          allowedToSend: false,
          blockers: ["agent-broker-write-disabled", "live-broker-write-is-enabled"],
        },
        safety: { sentOrder: false, noLiveOrderSent: true },
      },
      adapterAckGate: {
        schema: "openclaw.capital.external-broker-adapter-ack-gate.v1",
        status: "blocked",
        machineLine: "capitalAdapterAck=blocked hashOk=false noOrderWrite=true sentOrder=false",
        blockers: ["ack:sealed-intent-hash-match"],
        ack: {
          hashOk: false,
          canaryPass: true,
          rollbackPass: true,
          requiredTemplatePath:
            "D:/OpenClaw/.openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
        },
      },
      promotion: {
        status: "blocked",
        readyForManualReview: true,
        blockerCode: "LIVE_TRADING_MANUAL_REVIEW_REQUIRED",
        blockers: ["LIVE_TRADING_MANUAL_REVIEW_REQUIRED"],
      },
      operator: {
        status: "live_enabled",
        riskControls: { enabledAfter: true, allowLiveTrading: true, writeBrokerOrders: true },
        safety: { sentOrder: false },
      },
      armProfile: {
        status: "expired",
        armed: true,
        allowBrokerWriteWhenAllGatesPass: false,
        blockers: ["arm_profile:expired"],
        safety: { sentOrder: false, brokerWriteAttempted: false },
      },
    });

    const directPretradeCheck = report.checks.find(
      (check) => check.id === "direct:pretrade-allowed",
    );
    expect(directPretradeCheck?.status).toBe("pass");
    expect(report.blockers).not.toContain("direct:pretrade-allowed");
    expect(report.blockers).toContain("adapter:ack-usable");
    expect(report.blockers).toContain("executor:arm-profile-armed");
  });

  it("reports adapter-review readiness only when all gates pass without sending an order", () => {
    const report = buildCapitalLiveReadinessReport({
      repoRoot: baseRepoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      platform: {
        status: "blocked_live_promotion_required",
        blockers: [],
        quote: {
          overallFreshness: "multi_target_fresh",
          strategyQuoteReady: true,
          a50: { status: "stale" },
          multiTarget: { status: "fresh", freshPaperTargetCount: 5 },
        },
        strategyPlatform: {
          requestedTrade: { instrument: "A50 202605", holdingMode: "day_trade" },
        },
        strategy: {
          strategyFill: {
            recommendation: "promote",
            promotionGate: { status: "ready_for_paper_promotion", paperPromotionEligible: true },
          },
          strategyTailRiskRepair: {
            status: "tail_risk_passed",
            selectedSymbols: ["M2K0000"],
          },
        },
        positionDecision: { usable: true },
        externalBrokerAdapter: {
          ack: {
            status: "verified",
            usable: true,
            path: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
            requiredSealedIntentSha256: "READY123",
          },
        },
        execution: {
          sealedOrderIntentSha256: "READY123",
          positionDecision: { status: "verified_flat_no_exit_required" },
        },
        safety: { sentOrder: false, noLiveOrderSent: true },
      },
      direct: {
        status: "live_order_ready_to_send",
        decision: "live_order_dispatch_allowed",
        preTradeRiskGate: { allowedToSend: true, blockers: [] },
        safety: { sentOrder: false, noLiveOrderSent: true },
        liveOrderDraft: {
          brokerApi: "SendOverseaFutureOrder",
          commandPayload: { stockNo: "CN0000", dayTradeMode: "day_trade" },
        },
      },
      adapterAckGate: {
        schema: "openclaw.capital.external-broker-adapter-ack-gate.v1",
        status: "verified",
        machineLine: "capitalAdapterAck=verified hashOk=true noOrderWrite=true sentOrder=false",
        blockers: [],
        ack: {
          hashOk: true,
          canaryPass: true,
          rollbackPass: true,
          requiredTemplatePath:
            "D:/OpenClaw/.openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
        },
        operatorReview: {
          refreshPlan: {
            status: "not_required",
            reason: "active_ack_matches_current_sealed_intent",
            sourcePath:
              "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
            destinationPath:
              "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
            candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
            safeToPromoteCandidate: false,
            activeAckWriteSuppressed: true,
            conversationAgentsMayWriteActiveAck: false,
            allowedWriter: "operator-owned-broker-adapter-only",
            validationCommand: "pnpm capital:trade:adapter-ack:check",
            postRefreshValidationCommand: "pnpm capital:live-readiness:check",
          },
        },
      },
      promotion: {
        status: "blocked",
        readyForManualReview: true,
        blockerCode: "LIVE_TRADING_MANUAL_REVIEW_REQUIRED",
        blockers: ["LIVE_TRADING_MANUAL_REVIEW_REQUIRED"],
      },
      operator: {
        status: "live_enabled",
        riskControls: { enabledAfter: true, allowLiveTrading: true, writeBrokerOrders: true },
        safety: { sentOrder: false },
      },
      armProfile: {
        status: "armed",
        armed: true,
        allowBrokerWriteWhenAllGatesPass: true,
        allowConversationAgentDirectWrite: false,
        brokerWriteAuthorityTarget: "operator-owned-broker-adapter-only",
        expiresAt: "2026-05-25T01:00:00.000Z",
        blockers: [],
        paths: {
          profilePath: "D:/OpenClaw/.openclaw/trading/capital-live-executor-arm-profile.json",
          templatePath:
            "D:/OpenClaw/.openclaw/trading/templates/capital-live-executor-arm-profile.template.json",
        },
        safety: { sentOrder: false, brokerWriteAttempted: false },
      },
    });

    expect(report.status).toBe("ready_for_operator_adapter_review");
    expect(report.blockers).toEqual([]);
    expect(report.sealedOrderIntentSha256).toBe("READY123");
    expect(report.safety.sentOrder).toBe(false);
    expect(report.safety.writeBrokerOrders).toBe(false);
    expect(report.safety.readOnlyPreflightOnly).toBe(true);
    expect(report.readiness.direct.preTradeAllowed).toBe(true);
    expect(report.readiness.externalBrokerAdapter.ackUsable).toBe(true);
    expect(report.readiness.externalBrokerAdapter.ackGateStatus).toBe("verified");
    expect(report.readiness.externalBrokerAdapter.hashOk).toBe(true);
    expect(report.readiness.externalBrokerAdapter.refreshPlan.status).toBe("not_required");
    expect(report.machineLine).toContain("capitalLiveReadiness=ready_for_operator_adapter_review");
  });
});
