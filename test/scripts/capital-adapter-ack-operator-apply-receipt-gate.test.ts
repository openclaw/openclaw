import { describe, expect, it } from "vitest";
import { buildCapitalAdapterAckOperatorApplyReceiptGate } from "../../scripts/openclaw-capital-adapter-ack-operator-apply-receipt-gate.mjs";

const repoRoot = "D:\\OpenClaw";
const sourcePath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json";
const destinationPath = "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json";
const backupPath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.active-backup-CURRENT123.json";
const tempPath =
  "D:/OpenClaw/.openclaw/trading/.capital-external-broker-adapter-ack.CANDIDATE456.tmp";
const sealedIntentSha256 = "REQ123";
const rollbackVerifiedAt = "2026-05-26T08:29:20.000Z";

function applyVerifier(status = "ready_for_operator_apply") {
  const applied = status === "applied_verified";
  return {
    status,
    sealedIntentSha256,
    applyVerdict: {
      status,
      activeState: applied ? "applied_candidate_matches" : "pre_apply_current_matches",
      operatorMayApply: !applied,
      operatorApplyVerified: applied,
      packetPath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack-refresh-packet.json",
      sourcePath,
      destinationPath,
      backupPath,
      sealedIntentSha256,
      sourceSealedIntentSha256: sealedIntentSha256,
      destinationSealedIntentSha256: applied ? sealedIntentSha256 : "OLD123",
      currentContentSha256: "CURRENT123",
      candidateContentSha256: "CANDIDATE456",
      sourceContentSha256: "CANDIDATE456",
      destinationContentSha256: applied ? "CANDIDATE456" : "CURRENT123",
      candidateRollbackVerifiedAt: rollbackVerifiedAt,
    },
    safety: {
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-verifier-latest.json",
    },
  };
}

function applyPlan(status = "ready_atomic_apply_plan") {
  const applied = status === "already_applied_verified";
  return {
    status,
    sealedIntentSha256,
    operatorApplyPlan: {
      status,
      owner: "operator-owned-broker-adapter-only",
      dryRunOnly: true,
      applyAllowedByPlan: !applied,
      alreadyAppliedVerified: applied,
      sourcePath,
      destinationPath,
      backupPath,
      tempPath,
      sealedIntentSha256,
      currentContentSha256: "CURRENT123",
      candidateContentSha256: "CANDIDATE456",
    },
    safety: {
      generatedPlanOnly: true,
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      planPath:
        "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack-operator-apply-plan.json",
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-plan-latest.json",
    },
  };
}

describe("capital adapter ack operator apply receipt gate", () => {
  it("builds a pending receipt when the operator-owned apply is still required", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyReceiptGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: applyVerifier(),
      applyPlan: applyPlan(),
    });

    expect(report.status).toBe("pending_operator_apply");
    expect(report.blockers).toEqual(["operator-apply:pending"]);
    expect(report.operatorReceipt).toMatchObject({
      action: "operator_apply_required",
      operatorMayApply: true,
      operatorApplyVerified: false,
      applyAllowedByPlan: true,
      alreadyAppliedVerified: false,
      activeState: "pre_apply_current_matches",
      sealedIntentSha256,
      sourcePath,
      destinationPath,
      backupPath,
      tempPath,
    });
    expect(report.operatorReceipt.validationCommands.receipt).toBe(
      `pnpm --dir ${repoRoot} capital:trade:adapter-ack-apply-receipt:check`,
    );
    expect(report.operatorHandoff).toMatchObject({
      schema: "openclaw.capital.adapter-ack-operator-handoff.v1",
      status: "pending_operator_apply",
      nextAction: "operator_adapter_atomic_apply",
      allowedActor: "operator-controlled-broker-adapter",
      sourcePath,
      destinationPath,
      sealedIntentSha256,
      safety: {
        brokerOrderWriteAllowed: false,
        automationMayWriteActiveAck: false,
        telegramMayWriteActiveAck: false,
        reportOnly: true,
        noLiveOrderSent: true,
      },
    });
    expect(report.operatorHandoff.disallowedActors).toContain("openclaw-automation");
    expect(report.operatorHandoff.requiredValidation).toEqual([
      `pnpm --dir ${repoRoot} capital:trade:adapter-ack-apply-receipt:check`,
      `pnpm --dir ${repoRoot} capital:trade:adapter-ack:check`,
      `pnpm --dir ${repoRoot} capital:trade:post-apply-closure:check`,
    ]);
    expect(report.safety).toMatchObject({
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      sentOrder: false,
      noLiveOrderSent: true,
    });
  });

  it("verifies the receipt after the operator-owned adapter has applied the ack", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyReceiptGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: applyVerifier("applied_verified"),
      applyPlan: applyPlan("already_applied_verified"),
    });

    expect(report.status).toBe("applied_receipt_verified");
    expect(report.blockers).toEqual([]);
    expect(report.operatorReceipt).toMatchObject({
      action: "post_apply_closure_required",
      operatorMayApply: false,
      operatorApplyVerified: true,
      alreadyAppliedVerified: true,
      activeState: "applied_candidate_matches",
    });
    expect(report.operatorHandoff).toMatchObject({
      status: "applied_receipt_verified",
      nextAction: "rerun_post_apply_closure",
      safety: {
        brokerOrderWriteAllowed: false,
        automationMayWriteActiveAck: false,
      },
    });
  });

  it("blocks inconsistent verifier and plan states", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyReceiptGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: {
        ...applyVerifier("blocked"),
        applyVerdict: {
          ...applyVerifier().applyVerdict,
          activeState: "blocked_active_content_drift",
          operatorMayApply: false,
          destinationContentSha256: "DRIFT",
        },
      },
      applyPlan: applyPlan(),
    });

    expect(report.status).toBe("blocked_apply_receipt_incomplete");
    expect(report.blockers).toContain("verifier:ready-or-applied");
    expect(report.blockers).toContain("receipt:state-classified");
    expect(report.operatorHandoff.nextAction).toBe("fix_receipt_blockers");
    expect(report.safety.sentOrder).toBe(false);
  });
});
