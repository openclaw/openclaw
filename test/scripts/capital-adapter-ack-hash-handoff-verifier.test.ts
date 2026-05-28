import { describe, expect, it } from "vitest";
import { buildCapitalAdapterAckHashHandoffVerifierReport } from "../../scripts/openclaw-capital-adapter-ack-hash-handoff-verifier.mjs";

const repoRoot = "D:\\OpenClaw";
const activeAckPath = "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json";
const stagedCandidateAckPath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json";
const requiredTemplatePath =
  "D:/OpenClaw/.openclaw/trading/templates/capital-external-broker-adapter-ack.required-current.json";
const generatedAt = "2026-05-26T08:30:00.000Z";

function adapterAckGate(overrides = {}) {
  return {
    status: "blocked",
    sealedIntentSha256: "REQ123",
    ack: {
      hashOk: false,
      canaryPass: true,
      canarySentOrder: false,
      rollbackFresh: true,
      rollbackVerifiedAt: "2026-05-26T08:29:20.000Z",
      activePath: activeAckPath,
      sealedIntentHash: {
        expected: "REQ123",
        actual: "OLD123",
      },
    },
    operatorReview: {
      activeAckPath,
      stagedCandidateAckPath,
      requiredTemplatePath,
      expectedSealedIntentSha256: "REQ123",
      actualSealedIntentSha256: "OLD123",
      activeAckWriteSuppressed: true,
      conversationAgentsMayWriteActiveAck: false,
      allowedWriter: "operator-owned-broker-adapter-only",
      refreshPlan: {
        status: "operator_refresh_required",
        candidateSealedIntentSha256: "REQ123",
        candidateRollbackVerifiedAt: "2026-05-26T08:29:20.000Z",
        safeToPromoteCandidate: true,
        activeAckWriteSuppressed: true,
        conversationAgentsMayWriteActiveAck: false,
        allowedWriter: "operator-owned-broker-adapter-only",
      },
      candidateAck: {
        sealedIntentSha256: "REQ123",
        canary: { status: "pass", dryRun: true, sentOrder: false },
        rollback: { status: "pass", verifiedAt: "2026-05-26T08:29:20.000Z" },
      },
    },
    safety: {
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-external-broker-adapter-ack-gate-latest.json",
      stagedCandidateAckPath,
      requiredTemplatePath,
    },
    ...overrides,
  };
}

describe("capital adapter ack hash handoff verifier", () => {
  it("marks a safe hash mismatch as ready for operator-owned handoff", () => {
    const report = buildCapitalAdapterAckHashHandoffVerifierReport({
      repoRoot,
      generatedAt,
      adapterAckGate: adapterAckGate(),
    });

    expect(report.status).toBe("ready_for_operator_handoff");
    expect(report.blockers).toEqual([]);
    expect(report.hash).toMatchObject({
      hashOk: false,
      expectedSealedIntentSha256: "REQ123",
      actualSealedIntentSha256: "OLD123",
      candidateSealedIntentSha256: "REQ123",
      activeHashMismatchDetected: true,
      candidateMatchesSealedIntent: true,
    });
    expect(report.operatorHandoff).toMatchObject({
      status: "ready_for_operator_owned_ack_refresh",
      sourcePath: stagedCandidateAckPath,
      destinationPath: activeAckPath,
      requiredTemplatePath,
      candidateRollbackVerifiedAt: "2026-05-26T08:29:20.000Z",
      canaryPass: true,
      canarySentOrder: false,
      rollbackFresh: true,
      safeToPromoteCandidate: true,
      activeAckWriteSuppressed: true,
      conversationAgentsMayWriteActiveAck: false,
      allowedWriter: "operator-owned-broker-adapter-only",
    });
    expect(report.operatorHandoff.validationCommands.adapterAck).toBe(
      `pnpm --dir ${repoRoot} capital:trade:adapter-ack:check`,
    );
    expect(report.operatorHandoff.validationCommands.liveReadiness).toBe(
      `pnpm --dir ${repoRoot} capital:live-readiness:check`,
    );
    expect(report.operatorHandoff.validationCommands.operatorPacket).toBe(
      `pnpm --dir ${repoRoot} capital:trade:operator-packet:check`,
    );
    expect(report.operatorHandoff.handoffChecklist.map((item) => item.id)).toEqual([
      "review_staged_candidate_ack",
      "compare_active_and_candidate_hash",
      "verify_canary_no_order",
      "verify_rollback_freshness",
      "operator_owned_active_ack_refresh",
      "rerun_adapter_ack",
      "rerun_live_readiness",
    ]);
    expect(report.operatorHandoff.handoffChecklist).toContainEqual(
      expect.objectContaining({
        id: "operator_owned_active_ack_refresh",
        status: "pending_operator_owned_adapter",
      }),
    );
    expect(report.safety).toMatchObject({
      generatedReportOnly: true,
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    });
    expect(report.machineLine).toContain("noOrderWrite=true");
  });

  it("recognizes a matching active ack without requesting handoff", () => {
    const report = buildCapitalAdapterAckHashHandoffVerifierReport({
      repoRoot,
      generatedAt,
      adapterAckGate: adapterAckGate({
        status: "verified",
        ack: {
          hashOk: true,
          canaryPass: true,
          canarySentOrder: false,
          rollbackFresh: true,
          rollbackVerifiedAt: "2026-05-26T08:29:20.000Z",
          activePath: activeAckPath,
          sealedIntentHash: {
            expected: "REQ123",
            actual: "REQ123",
          },
        },
        operatorReview: {
          activeAckPath,
          stagedCandidateAckPath,
          requiredTemplatePath,
          expectedSealedIntentSha256: "REQ123",
          actualSealedIntentSha256: "REQ123",
          activeAckWriteSuppressed: true,
          conversationAgentsMayWriteActiveAck: false,
          allowedWriter: "operator-owned-broker-adapter-only",
          refreshPlan: {
            status: "not_required",
            candidateSealedIntentSha256: "REQ123",
            candidateRollbackVerifiedAt: "2026-05-26T08:29:20.000Z",
            safeToPromoteCandidate: false,
            activeAckWriteSuppressed: true,
            conversationAgentsMayWriteActiveAck: false,
            allowedWriter: "operator-owned-broker-adapter-only",
          },
          candidateAck: {
            sealedIntentSha256: "REQ123",
            canary: { status: "pass", dryRun: true, sentOrder: false },
            rollback: { status: "pass", verifiedAt: "2026-05-26T08:29:20.000Z" },
          },
        },
      }),
    });

    expect(report.status).toBe("verified_no_handoff_required");
    expect(report.hash.hashOk).toBe(true);
    expect(report.operatorHandoff.status).toBe("not_required");
    expect(report.operatorHandoff.handoffChecklist).toContainEqual(
      expect.objectContaining({
        id: "operator_owned_active_ack_refresh",
        status: "complete",
      }),
    );
    expect(report.safety.sentOrder).toBe(false);
  });
});
