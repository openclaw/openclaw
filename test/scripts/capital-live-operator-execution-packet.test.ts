import { describe, expect, it } from "vitest";
import { buildCapitalLiveOperatorExecutionPacketReport } from "../../scripts/openclaw-capital-live-operator-execution-packet.mjs";

const repoRoot = "D:\\OpenClaw";
const adapterAckCheckCommand = `pnpm --dir ${repoRoot} capital:trade:adapter-ack:check`;
const receiptCheckCommand = `pnpm --dir ${repoRoot} capital:trade:adapter-ack-apply-receipt:check`;
const liveReadinessCheckCommand = `pnpm --dir ${repoRoot} capital:live-readiness:check`;

const directReady = {
  status: "live_order_ready_to_send",
  preTradeRiskGate: { allowedToSend: true, blockers: [] },
  safety: { sentOrder: false },
  liveOrderDraft: { brokerApi: "SendOverseaFutureOrder", brokerStruct: "OVERSEAFUTUREORDER" },
  operatorHandoff: {
    handoffPacket: {
      sealedOrderIntent: { sha256: "HASH123", brokerWriteAllowedByOpenClaw: false },
      commandPayload: { stockNo: "CN0000", qty: 1, dayTradeMode: "day_trade" },
      brokerFields: { bstrStockNo: "CN0000", nQty: 1 },
      stops: { stopLoss: null, takeProfit: null },
    },
  },
};

const directReadyWithSafetyOnlyBlockers = {
  status: "live_order_dry_run_pretrade_blocked",
  preTradeRiskGate: {
    attachedBeforeBrokerSend: true,
    evaluated: true,
    allowedToSend: false,
    blockers: ["agent-broker-write-disabled", "live-broker-write-is-enabled"],
  },
  safety: { sentOrder: false },
  liveOrderDraft: { brokerApi: "SendOverseaFutureOrder", brokerStruct: "OVERSEAFUTUREORDER" },
  operatorHandoff: {
    handoffPacket: {
      sealedOrderIntent: { sha256: "HASH123", brokerWriteAllowedByOpenClaw: false },
      commandPayload: { stockNo: "CN0000", qty: 1, dayTradeMode: "day_trade" },
      brokerFields: { bstrStockNo: "CN0000", nQty: 1 },
      stops: { stopLoss: null, takeProfit: null },
    },
  },
};

function pendingApplyReceipt() {
  return {
    status: "pending_operator_apply",
    action: "operator_apply_required",
    blockers: ["operator-apply:pending"],
    operatorReceipt: {
      action: "operator_apply_required",
      operatorMayApply: true,
      operatorApplyVerified: false,
      alreadyAppliedVerified: false,
      activeState: "pre_apply_current_matches",
      sourcePath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
      destinationPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
      backupPath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.active-backup-CURRENT123.json",
      tempPath:
        "D:/OpenClaw/.openclaw/trading/.capital-external-broker-adapter-ack.CANDIDATE456.tmp",
      currentContentSha256: "CURRENT123",
      candidateContentSha256: "CANDIDATE456",
      validationCommands: {
        receipt: receiptCheckCommand,
      },
      safety: { sentOrder: false },
    },
    safety: { sentOrder: false, noLiveOrderSent: true },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
    },
    nextSafeTask: `operator-owned adapter must apply the staged ack, then rerun ${receiptCheckCommand}.`,
  };
}

function verifiedApplyReceipt() {
  return {
    status: "applied_receipt_verified",
    action: "post_apply_closure_required",
    blockers: [],
    operatorReceipt: {
      action: "post_apply_closure_required",
      operatorMayApply: false,
      operatorApplyVerified: true,
      alreadyAppliedVerified: true,
      activeState: "applied_candidate_matches",
      validationCommands: {
        receipt: receiptCheckCommand,
      },
      safety: { sentOrder: false },
    },
    safety: { sentOrder: false, noLiveOrderSent: true },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
    },
  };
}

describe("capital live operator execution packet", () => {
  it("stays blocked when readiness and adapter ack are not verified", () => {
    const report = buildCapitalLiveOperatorExecutionPacketReport({
      repoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      readiness: {
        status: "blocked",
        sealedOrderIntentSha256: "HASH123",
        blockers: ["adapter:ack-usable"],
        safety: { sentOrder: false },
      },
      adapterAck: {
        status: "blocked",
        sealedIntentSha256: "HASH123",
        blockers: ["ack:sealed-intent-hash-match"],
        safety: { sentOrder: false },
        ack: {
          hashOk: false,
          canaryPass: true,
          rollbackPass: true,
          rollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
          activePath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
          sealedIntentHash: {
            expected: "HASH123",
            actual: "OLD123",
            requiredTemplatePath:
              "D:/OpenClaw/.openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json",
            operatorAction:
              "operator-owned adapter must refresh active ack from required-current template",
          },
        },
        operatorReview: {
          status: "staged_candidate_ready_for_operator_adapter",
          activeAckPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
          stagedCandidateAckPath:
            "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          activeAckWriteSuppressed: true,
          allowedWriter: "operator-owned-broker-adapter-only",
          candidateAck: { sealedIntentSha256: "HASH123" },
          refreshPlan: {
            status: "operator_refresh_required",
            reason: "active_ack_hash_mismatch",
            sourcePath:
              "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
            destinationPath:
              "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
            expectedSealedIntentSha256: "HASH123",
            actualSealedIntentSha256: "OLD123",
            candidateSealedIntentSha256: "HASH123",
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
      applyReceipt: pendingApplyReceipt(),
      direct: directReady,
      armProfile: {
        status: "expired",
        armed: true,
        allowBrokerWriteWhenAllGatesPass: false,
        profilePath: "D:/OpenClaw/.openclaw/trading/capital-live-executor-arm-profile.json",
        templatePath:
          "D:/OpenClaw/.openclaw/trading/templates/capital-live-executor-arm-profile.template.json",
        expiresAt: "2026-05-26T10:29:17.063Z",
        blockers: ["arm_profile:expired"],
        operatorReview: {
          status: "staged_rearm_candidate_ready_for_operator",
          stagedRearmProfilePath:
            "D:/OpenClaw/.openclaw/trading/staging/capital-live-executor-arm-profile.staged-rearm.json",
          activeProfileWriteSuppressed: true,
          allowedWriter: "operator-managed-local-broker-executor-only",
        },
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.operatorCanExecute).toBe(false);
    expect(report.blockers).toContain("readiness:not-ready");
    expect(report.blockers).toContain("adapterAck:not-verified");
    expect(report.blockers).toContain("adapterAck:apply-receipt-not-verified");
    expect(report.blockerPlan.nextAction).toBe("adapter_apply_receipt");
    expect(report.blockerPlan.validationCommands).toContain(receiptCheckCommand);
    expect(report.blockerPlan.validationCommands).toContain(adapterAckCheckCommand);
    expect(report.blockerPlan.orderedActions.map((action) => action.id)).toEqual([
      "adapter_apply_receipt",
      "adapter_ack_hash",
      "live_executor_arm_profile",
      "readiness_aggregation",
    ]);
    const receiptAction = report.blockerPlan.orderedActions.find(
      (action) => action.id === "adapter_apply_receipt",
    );
    expect(receiptAction).toMatchObject({
      gate: "adapter:apply-receipt-verified",
      validationCommand: receiptCheckCommand,
      operatorMayApply: true,
      operatorApplyVerified: false,
      activeState: "pre_apply_current_matches",
    });
    const adapterAckAction = report.blockerPlan.orderedActions.find(
      (action) => action.id === "adapter_ack_hash",
    );
    expect(adapterAckAction).toMatchObject({
      expectedSealedIntentSha256: "HASH123",
      actualSealedIntentSha256: "OLD123",
      stagedCandidateAckPath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
      activeAckPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
      activeAckWriteSuppressed: true,
      allowedWriter: "operator-owned-broker-adapter-only",
      refreshPlan: {
        status: "operator_refresh_required",
        reason: "active_ack_hash_mismatch",
        sourcePath:
          "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
        destinationPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
        candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
        safeToPromoteCandidate: true,
        validationCommand: adapterAckCheckCommand,
        postRefreshValidationCommand: liveReadinessCheckCommand,
      },
    });
    expect(adapterAckAction?.refreshPlan).toMatchObject({
      status: "operator_refresh_required",
      reason: "active_ack_hash_mismatch",
      candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
      safeToPromoteCandidate: true,
      validationCommand: adapterAckCheckCommand,
      postRefreshValidationCommand: liveReadinessCheckCommand,
    });
    expect(adapterAckAction?.stagedCandidateAckPath).not.toBe(adapterAckAction?.activeAckPath);
    const armAction = report.blockerPlan.orderedActions.find(
      (action) => action.id === "live_executor_arm_profile",
    );
    expect(armAction).toMatchObject({
      id: "live_executor_arm_profile",
      stagedRearmProfilePath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-live-executor-arm-profile.staged-rearm.json",
      activeProfileWriteSuppressed: true,
      allowedWriter: "operator-managed-local-broker-executor-only",
    });
    expect(report.liveExecutorArmProfile).toMatchObject({
      operatorReviewStatus: "staged_rearm_candidate_ready_for_operator",
      stagedRearmProfilePath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-live-executor-arm-profile.staged-rearm.json",
      activeProfileWriteSuppressed: true,
      allowedWriter: "operator-managed-local-broker-executor-only",
    });
    expect(report.adapterAck).toMatchObject({
      stagedCandidateAckPath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
      stagedCandidateSealedIntentSha256: "HASH123",
      activeAckWriteSuppressed: true,
      allowedWriter: "operator-owned-broker-adapter-only",
      refreshPlan: expect.objectContaining({
        candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
      }),
      applyReceipt: expect.objectContaining({
        status: "pending_operator_apply",
        verified: false,
        operatorMayApply: true,
        operatorApplyVerified: false,
        validationCommand: receiptCheckCommand,
      }),
    });
    expect(report.executionPayload.dispatchPolicy).toBe("blocked_do_not_send");
    expect(report.safety.writeBrokerOrders).toBe(false);
    expect(report.safety.sentOrder).toBe(false);
  });

  it("marks operator packet ready only after readiness, ack, apply receipt, and direct pretrade pass", () => {
    const report = buildCapitalLiveOperatorExecutionPacketReport({
      repoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      readiness: {
        status: "ready_for_operator_adapter_review",
        sealedOrderIntentSha256: "HASH123",
        blockers: [],
        safety: { sentOrder: false },
      },
      adapterAck: {
        status: "verified",
        sealedIntentSha256: "HASH123",
        blockers: [],
        safety: { sentOrder: false },
        ack: { hashOk: true, canaryPass: true, rollbackPass: true },
      },
      applyReceipt: verifiedApplyReceipt(),
      direct: directReady,
      armProfile: {
        status: "armed",
        armed: true,
        allowBrokerWriteWhenAllGatesPass: true,
        blockers: [],
      },
    });

    expect(report.status).toBe("operator_adapter_execution_ready");
    expect(report.operatorCanExecute).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.liveExecutorArmProfile.allowFieldContract).toMatchObject({
      status: "canonical",
      hasRequiredKey: true,
      explicitFailure: false,
    });
    expect(report.liveExecutorArmProfile.allowBrokerWriteWhenAllGatesPass).toBe(true);
    expect(report.adapterAck.applyReceipt).toMatchObject({
      status: "applied_receipt_verified",
      verified: true,
      operatorApplyVerified: true,
      alreadyAppliedVerified: true,
      activeState: "applied_candidate_matches",
    });
    expect(report.blockerPlan).toMatchObject({
      status: "clear",
      nextAction: "none_required",
      orderedActionCount: 0,
    });
    expect(report.executionPayload.commandPayload.stockNo).toBe("CN0000");
    expect(report.executionPayload.dispatchPolicy).toBe(
      "operator_adapter_may_execute_after_own_final_confirmation",
    );
    expect(report.safety.requiresExternalOperatorOwnedAdapter).toBe(true);
    expect(report.safety.noLiveOrderSent).toBe(true);
  });

  it("treats direct pretrade as ready when only safety-only blockers remain", () => {
    const report = buildCapitalLiveOperatorExecutionPacketReport({
      repoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      readiness: {
        status: "blocked",
        sealedOrderIntentSha256: "HASH123",
        blockers: ["adapter:ack-usable"],
        safety: { sentOrder: false },
      },
      adapterAck: {
        status: "blocked",
        sealedIntentSha256: "HASH123",
        blockers: ["ack:sealed-intent-hash-match"],
        safety: { sentOrder: false },
        ack: { hashOk: false, canaryPass: true, rollbackPass: true },
      },
      applyReceipt: pendingApplyReceipt(),
      direct: directReadyWithSafetyOnlyBlockers,
      armProfile: {
        status: "expired",
        armed: true,
        allowBrokerWriteWhenAllGatesPass: false,
        blockers: ["arm_profile:expired"],
      },
    });

    expect(report.blockers).not.toContain("direct:pretrade-not-ready");
    expect(report.blockers).not.toContain("direct:agent-broker-write-disabled");
    expect(report.blockers).not.toContain("direct:live-broker-write-is-enabled");
    expect(report.blockerPlan.orderedActions.map((action) => action.id)).not.toContain(
      "direct_pretrade_clear",
    );
  });
});
