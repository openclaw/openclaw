import { describe, expect, it } from "vitest";
import { buildCapitalExternalBrokerAdapterAckReport } from "../../scripts/openclaw-capital-external-broker-adapter-ack-gate.mjs";

const baseGate = {
  safety: { sentOrder: false },
  operatorHandoff: {
    externalBrokerAdapter: {
      ack: {
        path: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
        status: "blocked",
        exists: true,
        requiredSealedIntentSha256: "REQ123",
      },
    },
    handoffPacket: {
      sealedOrderIntent: {
        sha256: "REQ123",
      },
    },
  },
};
const repoRoot = "D:\\OpenClaw";
const adapterAckCheckCommand = `pnpm --dir ${repoRoot} capital:trade:adapter-ack:check`;
const liveReadinessCheckCommand = `pnpm --dir ${repoRoot} capital:live-readiness:check`;

describe("capital external broker adapter ack gate", () => {
  it("blocks stale ack hashes while producing the current required template", () => {
    const report = buildCapitalExternalBrokerAdapterAckReport({
      repoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      gate: baseGate,
      currentAck: {
        schema: "openclaw.capital.external-broker-adapter-ack.v1",
        owner: "operator",
        sealedIntentSha256: "OLD123",
        canary: { status: "pass", dryRun: true, sentOrder: false },
        rollback: { status: "pass", verifiedAt: "2026-05-25T00:00:00.000Z" },
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("ack:sealed-intent-hash-match");
    expect(report.ack.hashOk).toBe(false);
    expect(report.ack.sealedIntentHash).toMatchObject({
      expected: "REQ123",
      actual: "OLD123",
      matched: false,
      mismatch: true,
    });
    expect(report.ack.sealedIntentHash.operatorAction).toContain("required-current template");
    expect(report.ack.expectedValue.sealedIntentSha256).toBe("REQ123");
    expect(report.operatorReview).toMatchObject({
      status: "staged_candidate_ready_for_operator_adapter",
      expectedSealedIntentSha256: "REQ123",
      actualSealedIntentSha256: "OLD123",
      activeAckWriteSuppressed: true,
      conversationAgentsMayWriteActiveAck: false,
      allowedWriter: "operator-owned-broker-adapter-only",
      validationCommand: adapterAckCheckCommand,
    });
    expect(report.operatorReview.activeVsCandidate).toMatchObject({
      status: "mismatch",
      activeAckPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
      stagedCandidateAckPath: report.operatorReview.stagedCandidateAckPath,
    });
    expect(report.operatorReview.activeVsCandidate.fields).toContainEqual({
      field: "sealedIntentSha256",
      active: "OLD123",
      candidate: "REQ123",
      matched: false,
    });
    expect(report.operatorReview.refreshPlan).toMatchObject({
      status: "operator_refresh_required",
      reason: "active_ack_hash_mismatch",
      sourcePath: report.operatorReview.stagedCandidateAckPath,
      destinationPath: report.operatorReview.activeAckPath,
      expectedSealedIntentSha256: "REQ123",
      actualSealedIntentSha256: "OLD123",
      candidateSealedIntentSha256: "REQ123",
      candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
      safeToPromoteCandidate: true,
      activeAckWriteSuppressed: true,
      conversationAgentsMayWriteActiveAck: false,
      allowedWriter: "operator-owned-broker-adapter-only",
      validationCommand: adapterAckCheckCommand,
      postRefreshValidationCommand: liveReadinessCheckCommand,
    });
    expect(report.operatorReview.handoffChecklist.map((item) => item.id)).toEqual([
      "review_staged_candidate_ack",
      "verify_canary_dry_run",
      "verify_rollback_freshness",
      "operator_owned_active_ack_refresh",
      "rerun_live_readiness",
    ]);
    expect(report.operatorReview.handoffChecklist).toContainEqual(
      expect.objectContaining({
        id: "operator_owned_active_ack_refresh",
        status: "pending_operator_owned_adapter",
      }),
    );
    expect(report.operatorReview.stagedCandidateAckPath).not.toBe(
      report.operatorReview.activeAckPath,
    );
    expect(report.operatorReview.candidateAck.sealedIntentSha256).toBe("REQ123");
    expect(report.operatorReview.candidateAck.rollback.verifiedAt).toBe("2026-05-25T00:00:00.000Z");
    expect(report.operatorReview.activeVsCandidate.fields).toContainEqual({
      field: "rollback.verifiedAt",
      active: "2026-05-25T00:00:00.000Z",
      candidate: "2026-05-25T00:00:00.000Z",
      matched: true,
    });
    expect(report.paths.stagedCandidateAckPath).toBe(report.operatorReview.stagedCandidateAckPath);
    expect(report.safety.generatedStagedCandidateAck).toBe(true);
    expect(report.safety.wroteActiveAdapterAck).toBe(false);
    expect(report.safety.activeAckWriteSuppressed).toBe(true);
    expect(report.safety.noLiveOrderSent).toBe(true);
    expect(report.machineLine).toContain("noOrderWrite=true");
  });

  it("verifies matching operator ack without enabling broker writes", () => {
    const report = buildCapitalExternalBrokerAdapterAckReport({
      repoRoot,
      generatedAt: "2026-05-25T00:00:00.000Z",
      gate: baseGate,
      currentAck: {
        schema: "openclaw.capital.external-broker-adapter-ack.v1",
        adapterId: "operator-capital-live-adapter",
        owner: "operator",
        sealedIntentSha256: "REQ123",
        canary: { status: "pass", dryRun: true, sentOrder: false },
        rollback: { status: "pass", verifiedAt: "2026-05-25T00:00:00.000Z" },
      },
    });

    expect(report.status).toBe("verified");
    expect(report.blockers).toEqual([]);
    expect(report.ack.usable).toBe(true);
    expect(report.ack.sealedIntentHash).toMatchObject({
      expected: "REQ123",
      actual: "REQ123",
      matched: true,
      mismatch: false,
      operatorAction: "none_required",
    });
    expect(report.operatorReview.status).toBe("no_refresh_required");
    expect(report.operatorReview.activeVsCandidate.status).toBe("matching");
    expect(report.operatorReview.refreshPlan).toMatchObject({
      status: "not_required",
      reason: "active_ack_matches_current_sealed_intent",
      safeToPromoteCandidate: false,
    });
    expect(report.operatorReview.handoffChecklist).toContainEqual(
      expect.objectContaining({
        id: "operator_owned_active_ack_refresh",
        status: "complete",
      }),
    );
    expect(report.safety.writeBrokerOrders).toBe(false);
    expect(report.safety.sentOrder).toBe(false);
    expect(report.machineLine).toContain("capitalAdapterAck=verified");
  });
});
