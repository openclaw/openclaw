import { describe, expect, it } from "vitest";
import { buildCapitalAdapterAckOperatorApplyPlan } from "../../scripts/openclaw-capital-adapter-ack-operator-apply-plan.mjs";

const repoRoot = "D:\\OpenClaw";
const sourcePath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json";
const destinationPath = "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json";
const backupPath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.active-backup-CURRENT123.json";
const sealedIntentSha256 = "REQ123";

function verifier(status = "ready_for_operator_apply") {
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
      currentContentSha256: "CURRENT123",
      candidateContentSha256: "CANDIDATE456",
      destinationContentSha256: applied ? "CANDIDATE456" : "CURRENT123",
    },
    safety: {
      noLiveOrderSent: true,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-verifier-latest.json",
    },
  };
}

describe("capital adapter ack operator apply plan", () => {
  it("builds a dry-run atomic apply plan when verifier is ready", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyPlan({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      verifier: verifier(),
    });

    expect(report.status).toBe("ready_atomic_apply_plan");
    expect(report.blockers).toEqual([]);
    expect(report.operatorApplyPlan).toMatchObject({
      owner: "operator-owned-broker-adapter-only",
      dryRunOnly: true,
      applyAllowedByPlan: true,
      alreadyAppliedVerified: false,
      sourcePath,
      destinationPath,
      backupPath,
      currentContentSha256: "CURRENT123",
      candidateContentSha256: "CANDIDATE456",
    });
    expect(report.operatorApplyPlan.tempPath).toContain("CANDIDATE456");
    expect(report.operatorApplyPlan.orderedDryRunOperations.map((item) => item.id)).toEqual([
      "verify_destination_current_hash",
      "verify_source_candidate_hash",
      "plan_backup_active_ack",
      "plan_write_temp_candidate",
      "plan_atomic_replace_active_ack",
      "post_apply_verify_adapter_ack",
      "post_apply_verify_live_readiness",
    ]);
    expect(report.safety).toMatchObject({
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      sentOrder: false,
      noLiveOrderSent: true,
    });
  });

  it("marks the plan already verified when apply verifier sees candidate active", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyPlan({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      verifier: verifier("applied_verified"),
    });

    expect(report.status).toBe("already_applied_verified");
    expect(report.operatorApplyPlan.applyAllowedByPlan).toBe(false);
    expect(report.operatorApplyPlan.alreadyAppliedVerified).toBe(true);
  });

  it("blocks when verifier is blocked", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyPlan({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      verifier: {
        ...verifier("blocked"),
        applyVerdict: {
          ...verifier().applyVerdict,
          activeState: "blocked_active_content_drift",
          operatorMayApply: false,
          destinationContentSha256: "DRIFT",
        },
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("verifier:ready-or-applied");
    expect(report.safety.sentOrder).toBe(false);
  });
});
