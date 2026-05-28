import { describe, expect, it } from "vitest";
import { buildCapitalLocalBrokerExecutorDispatchContract } from "../../scripts/openclaw-capital-local-broker-executor-dispatch-contract.mjs";

describe("capital local broker executor dispatch contract", () => {
  it("projects adapter ack rollback evidence from the operator packet while staying blocked", async () => {
    const report = await buildCapitalLocalBrokerExecutorDispatchContract({
      repoRoot: "D:\\OpenClaw",
      now: new Date("2026-05-25T00:00:00.000Z"),
      operatorPacket: {
        status: "blocked",
        sealedIntentSha256: "HASH123",
        operatorCanExecute: false,
        readiness: { status: "blocked" },
        liveExecutorArmProfile: {
          status: "expired",
          allowBrokerWriteWhenAllGatesPass: false,
          expiresAt: "2026-05-25T00:15:00.000Z",
        },
        adapterAck: {
          status: "blocked",
          hashOk: false,
          canarySentOrder: false,
          rollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
          rollbackFresh: true,
          expectedSealedIntentSha256: "HASH123",
          actualSealedIntentSha256: "OLD123",
          activeAckPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
          stagedCandidateAckPath:
            "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
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
            validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack:check",
            postRefreshValidationCommand: "pnpm --dir D:\\OpenClaw capital:live-readiness:check",
            allowedWriter: "operator-owned-broker-adapter-only",
          },
        },
        executionPayload: {
          liveExecutorArmed: false,
          dispatchPolicy: "blocked_do_not_send",
          brokerApi: "SendOverseaFutureOrder",
          brokerStruct: "OVERSEAFUTUREORDER",
          commandPayload: { stockNo: "CN0000", qty: 1 },
          brokerFields: { bstrStockNo: "CN0000", nQty: 1 },
          sealedOrderIntent: { sha256: "HASH123" },
        },
        blockers: ["adapterAck:not-verified", "liveExecutor:arm_profile:expired"],
        safety: {
          sentOrder: false,
          noLiveOrderSent: true,
          brokerWriteAttempted: false,
        },
        paths: {
          reportPath:
            "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-live-operator-execution-packet-latest.json",
        },
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.dispatchPolicy).toBe("blocked_do_not_send");
    expect(report.operatorPacket.operatorCanExecute).toBe(false);
    expect(report.operatorPacket.adapterAckHashOk).toBe(false);
    expect(report.operatorPacket.adapterAckRefreshPlan.candidateRollbackVerifiedAt).toBe(
      "2026-05-25T00:00:00.000Z",
    );
    expect(report.adapterAck.refreshPlan).toMatchObject({
      status: "operator_refresh_required",
      safeToPromoteCandidate: true,
      candidateRollbackVerifiedAt: "2026-05-25T00:00:00.000Z",
      allowedWriter: "operator-owned-broker-adapter-only",
    });
    expect(report.safety.sentOrder).toBe(false);
    expect(report.dispatchContract.brokerApiCalled).toBe(false);
  });
});
