import { describe, expect, it } from "vitest";
import {
  buildGateChecklist,
  deriveNextSafeTask,
} from "../../scripts/openclaw-capital-live-readiness-simulation.mjs";

function reportsWithReceipt(status: "pending_operator_apply" | "applied_receipt_verified") {
  const applied = status === "applied_receipt_verified";
  return {
    coreProductMatrix: {
      json: {
        schema: "openclaw.capital.core-product-freshness-matrix.v1",
        status: "ready",
        ready: true,
        summary: {
          requiredReady: true,
          blockedRequiredIds: [],
          sessionClosedRequiredIds: [],
        },
      },
    },
    directStatus: {
      json: {
        summary: {
          quote: { a50Status: "fresh" },
          requestedTrade: { status: "ready" },
          position: { decisionStatus: "verified_flat_no_exit_required" },
        },
      },
    },
    platformGate: {
      json: {
        liveCompletion: {
          stages: [
            { id: "quote:strategy-ready", status: "pass", evidence: {} },
            { id: "position:verified-fresh", status: "pass", evidence: {} },
            { id: "strategy:paper-promoted", status: "pass", evidence: {} },
            { id: "adapter:ack-hash-match", status: "pass", evidence: {} },
            { id: "adapter:canary-no-order", status: "pass", evidence: {} },
            { id: "adapter:rollback-fresh", status: "pass", evidence: {} },
            { id: "direct:pretrade-clear", status: "pass", evidence: {} },
            { id: "operator-packet:execution-ready", status: "pass", evidence: {} },
          ],
        },
      },
    },
    adapterAck: {
      json: {
        ack: {
          hashOk: true,
          canaryPass: true,
          canarySentOrder: false,
          rollbackFresh: true,
        },
      },
    },
    adapterApplyReceipt: {
      json: {
        status,
        operatorReceipt: {
          action: applied ? "post_apply_closure_required" : "operator_apply_required",
          activeState: applied ? "applied_candidate_matches" : "pre_apply_current_matches",
          operatorMayApply: !applied,
          operatorApplyVerified: applied,
          alreadyAppliedVerified: applied,
          sourcePath:
            "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json",
          destinationPath: "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json",
        },
        safety: {
          noLiveOrderSent: true,
          writeBrokerOrders: false,
        },
      },
    },
    liveExecutorProfile: {
      json: {
        status: "armed",
        armed: true,
        allowBrokerWriteWhenAllGatesPass: true,
        operatorSignaturePresent: true,
        expired: false,
      },
    },
    operatorPacket: {
      json: {
        status: "ready",
        operatorCanExecute: true,
      },
    },
    localExecutorDispatch: {
      json: {
        status: "ready",
        dispatchPolicy: "operator_adapter_may_execute_after_own_final_confirmation",
        operatorPacket: { operatorCanExecute: true },
        executor: { armed: true },
        safety: { sentOrder: false },
      },
    },
    tradingAgents: {
      json: {
        status: "upstream_ready",
        canAnalyzeNow: true,
        runtime: {
          provider: "tradingagents",
          mode: "paper_signal_only",
          noOrderWrite: true,
        },
        brokerWriteAttempted: false,
        no_live_order_sent: true,
      },
    },
    currentPaperIntents: {
      json: {
        schema: "openclaw.capital.current-paper-intents-from-target-registry.v1",
        status: "current_paper_intents_written",
        targetRegistry: {
          generatedIntentCount: 1,
          writtenTargetIds: ["tx-front"],
        },
        safety: {
          noLiveOrderSent: true,
          writeBrokerOrders: false,
        },
      },
    },
    riskResizedRerun: { json: { status: "pass" } },
  };
}

describe("capital live readiness simulation", () => {
  it("blocks readiness and routes next task to apply receipt when receipt is pending", () => {
    const reports = reportsWithReceipt("pending_operator_apply");
    const gates = buildGateChecklist(reports);
    const receiptGate = gates.find((gate) => gate.id === "adapter:apply-receipt-verified");

    expect(receiptGate).toMatchObject({
      status: "blocked",
      validationCommand: "pnpm capital:trade:adapter-ack-apply-receipt:check",
    });
    expect(receiptGate?.currentEvidence).toMatchObject({
      status: "pending_operator_apply",
      operatorMayApply: true,
      operatorApplyVerified: false,
    });
    expect(deriveNextSafeTask(gates, reports)).toBe(
      "pnpm capital:trade:adapter-ack-apply-receipt:check",
    );
  });

  it("passes the receipt gate after operator apply receipt is verified", () => {
    const gates = buildGateChecklist(reportsWithReceipt("applied_receipt_verified"));
    const receiptGate = gates.find((gate) => gate.id === "adapter:apply-receipt-verified");

    expect(receiptGate).toMatchObject({
      status: "pass",
      validationCommand: "pnpm capital:trade:adapter-ack-apply-receipt:check",
    });
    expect(receiptGate?.currentEvidence).toMatchObject({
      status: "applied_receipt_verified",
      operatorMayApply: false,
      operatorApplyVerified: true,
      alreadyAppliedVerified: true,
    });
  });
});
