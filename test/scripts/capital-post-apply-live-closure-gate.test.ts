import { describe, expect, it } from "vitest";
import { buildCapitalPostApplyLiveClosureGate } from "../../scripts/openclaw-capital-post-apply-live-closure-gate.mjs";

const repoRoot = "D:\\OpenClaw";
const sealedIntentSha256 = "REQ123";
const sourcePath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json";
const destinationPath = "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json";
const backupPath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.active-backup-CURRENT123.json";
const tempPath =
  "D:/OpenClaw/.openclaw/trading/.capital-external-broker-adapter-ack.CANDIDATE456.tmp";
const currentContentSha256 = "CURRENT123";
const candidateContentSha256 = "CANDIDATE456";

function appliedVerifier() {
  return {
    status: "applied_verified",
    sealedIntentSha256,
    applyVerdict: {
      status: "applied_verified",
      activeState: "applied_candidate_matches",
      operatorMayApply: false,
      operatorApplyVerified: true,
      sourcePath,
      destinationPath,
      backupPath,
      sealedIntentSha256,
      destinationSealedIntentSha256: sealedIntentSha256,
      currentContentSha256,
      candidateContentSha256,
      destinationContentSha256: candidateContentSha256,
      candidateRollbackVerifiedAt: "2026-05-26T09:00:00.000Z",
    },
    safety: {
      noLiveOrderSent: true,
      sentOrder: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-verifier-latest.json",
    },
  };
}

function applyPlan(alreadyAppliedVerified = true) {
  return {
    status: alreadyAppliedVerified ? "already_applied_verified" : "ready_atomic_apply_plan",
    sealedIntentSha256,
    operatorApplyPlan: {
      status: alreadyAppliedVerified ? "already_applied_verified" : "ready_atomic_apply_plan",
      applyAllowedByPlan: !alreadyAppliedVerified,
      alreadyAppliedVerified,
      sealedIntentSha256,
      sourcePath,
      destinationPath,
      backupPath,
      tempPath,
      currentContentSha256,
      candidateContentSha256,
    },
    safety: {
      noLiveOrderSent: true,
      sentOrder: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-plan-latest.json",
    },
  };
}

function liveReadinessReady() {
  return {
    status: "ready_for_operator_execution_review",
    operatorCanExecute: true,
    incompleteCount: 0,
    incompleteChecklist: [],
    nextCommands: [],
    sealedOrderIntent: {
      sha256: sealedIntentSha256,
    },
    safety: {
      noLiveOrderSent: true,
      sentOrder: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-live-readiness-simulation-latest.json",
    },
  };
}

function dispatchReady() {
  return {
    status: "ready_for_local_executor_final_confirmation",
    sealedIntentSha256,
    dispatchPolicy: "local_executor_may_dispatch_after_executor_owned_final_confirmation",
    operatorPacket: {
      operatorCanExecute: true,
    },
    executor: {
      armed: true,
    },
    blockers: [],
    safety: {
      localBrokerExecutorWriteAllowedAfterGates: true,
      noLiveOrderSent: true,
      sentOrder: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
    },
  };
}

describe("capital post-apply live closure gate", () => {
  it("closes only after adapter apply, live readiness, and dispatch are all ready", async () => {
    const report = await buildCapitalPostApplyLiveClosureGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: appliedVerifier(),
      applyPlan: applyPlan(),
      liveReadiness: liveReadinessReady(),
      dispatch: dispatchReady(),
    });

    expect(report.status).toBe("closed_ready_for_operator_final_review");
    expect(report.operatorCanExecute).toBe(true);
    expect(report.adapterApplyReceipt).toMatchObject({
      verified: true,
      status: "applied_receipt_verified",
      operatorApplyVerified: true,
    });
    expect(report.blockers).toEqual([]);
    expect(report.safety).toMatchObject({
      localBrokerExecutorWriteAllowedAfterGates: true,
      sentOrder: false,
      noLiveOrderSent: true,
    });
  });

  it("blocks when operator adapter has not applied the candidate ack", async () => {
    const verifier = {
      ...appliedVerifier(),
      status: "ready_for_operator_apply",
      applyVerdict: {
        ...appliedVerifier().applyVerdict,
        status: "ready_for_operator_apply",
        activeState: "pre_apply_current_matches",
        operatorMayApply: true,
        operatorApplyVerified: false,
        destinationSealedIntentSha256: "OLD",
        destinationContentSha256: currentContentSha256,
      },
    };
    const report = await buildCapitalPostApplyLiveClosureGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: verifier,
      applyPlan: applyPlan(false),
      liveReadiness: liveReadinessReady(),
      dispatch: dispatchReady(),
    });

    expect(report.status).toBe("blocked_post_apply_closure_incomplete");
    expect(report.operatorCanExecute).toBe(false);
    expect(report.adapterApplyReceipt).toMatchObject({
      verified: false,
      status: "pending_operator_apply",
      operatorMayApply: true,
    });
    expect(report.blockers).toContain("adapterAck:operator-apply-receipt-not-verified");
    expect(report.blockers).toContain("adapterAck:operator-apply-not-verified");
    expect(report.nextSafeTask).toContain("operator-owned adapter must apply");
  });

  it("projects live-readiness and dispatch blockers into one closure report", async () => {
    const report = await buildCapitalPostApplyLiveClosureGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: appliedVerifier(),
      applyPlan: applyPlan(),
      liveReadiness: {
        ...liveReadinessReady(),
        status: "blocked_live_readiness_incomplete",
        operatorCanExecute: false,
        incompleteCount: 1,
        incompleteChecklist: [
          {
            id: "executor:arm-profile-armed",
            priority: "P0",
            status: "blocked",
            validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check",
          },
        ],
        nextCommands: ["pnpm --dir D:\\OpenClaw capital:trade:live-executor-profile:check"],
      },
      dispatch: {
        ...dispatchReady(),
        status: "blocked",
        dispatchPolicy: "blocked_do_not_send",
        blockers: ["executor:arm-profile-not-armed"],
        safety: {
          ...dispatchReady().safety,
          localBrokerExecutorWriteAllowedAfterGates: false,
        },
      },
    });

    expect(report.status).toBe("blocked_post_apply_closure_incomplete");
    expect(report.blockers).toContain("liveReadiness:executor:arm-profile-armed");
    expect(report.blockers).toContain("localExecutor:executor:arm-profile-not-armed");
    expect(report.localExecutorDispatch.ready).toBe(false);
  });

  it("projects formal live-readiness gate blockers instead of stale simulation blockers", async () => {
    const report = await buildCapitalPostApplyLiveClosureGate({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      applyVerifier: appliedVerifier(),
      applyPlan: applyPlan(),
      liveReadiness: {
        status: "blocked",
        blockers: ["direct:pretrade-allowed", "adapter:ack-usable", "executor:arm-profile-armed"],
        remainingBlockers: [
          "direct:pretrade-allowed",
          "adapter:ack-usable",
          "executor:arm-profile-armed",
          "platform:stale-simulation-noise",
        ],
        checks: [
          { id: "quote:strategy-fresh", status: "pass" },
          { id: "position:verified-snapshot", status: "pass" },
          { id: "strategy:paper-promoted", status: "pass" },
          { id: "direct:pretrade-allowed", status: "fail" },
          { id: "adapter:ack-usable", status: "fail" },
          { id: "executor:arm-profile-armed", status: "fail" },
        ],
        safety: {
          noLiveOrderSent: true,
          sentOrder: false,
          brokerWriteAttempted: false,
          writeBrokerOrders: false,
        },
        paths: {
          reportPath:
            "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-live-readiness-gate-latest.json",
        },
      },
      dispatch: dispatchReady(),
    });

    expect(report.status).toBe("blocked_post_apply_closure_incomplete");
    expect(report.liveReadiness.status).toBe("blocked");
    expect(report.liveReadiness.incompleteCount).toBe(3);
    expect(report.liveReadiness.reportPath).toContain("openclaw-capital-live-readiness-gate");
    expect(report.liveReadiness.nextCommands).toEqual([
      "pnpm --dir D:\\OpenClaw capital:live-readiness:check",
    ]);
    expect(report.blockers).toContain("liveReadiness:direct:pretrade-allowed");
    expect(report.blockers).toContain("liveReadiness:adapter:ack-usable");
    expect(report.blockers).toContain("liveReadiness:executor:arm-profile-armed");
    expect(report.blockers).not.toContain("liveReadiness:platform:stale-simulation-noise");
  });
});
