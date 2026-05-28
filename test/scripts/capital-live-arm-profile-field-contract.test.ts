import { describe, expect, it } from "vitest";
import {
  CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD,
  buildCapitalLiveExecutorArmProfile,
} from "../../scripts/openclaw-capital-live-executor-arm-profile.mjs";
import {
  CAPITAL_OPERATOR_PACKET_ARM_PROFILE_REQUIRED_ALLOW_FIELD,
  buildCapitalLiveOperatorExecutionPacketReport,
} from "../../scripts/openclaw-capital-live-operator-execution-packet.mjs";

const repoRoot = "D:\\OpenClaw";

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

describe("capital live arm profile field contract", () => {
  it("uses the same required allow field in arm-profile and operator-packet", () => {
    expect(CAPITAL_OPERATOR_PACKET_ARM_PROFILE_REQUIRED_ALLOW_FIELD).toBe(
      CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD,
    );
  });

  it("exposes canonical allow field and deprecated alias in arm-profile report", async () => {
    const report = await buildCapitalLiveExecutorArmProfile({ repoRoot });
    expect(report).toHaveProperty(CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD);
    expect(report).toHaveProperty("allowExecutorWrite");
    expect(report.allowExecutorWrite).toBe(report[CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD]);
  });

  it("fails explicitly when operator-packet only receives deprecated allow key", () => {
    const report = buildCapitalLiveOperatorExecutionPacketReport({
      repoRoot,
      generatedAt: "2026-05-27T00:00:00.000Z",
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
      applyReceipt: {
        status: "applied_receipt_verified",
        blockers: [],
        action: "post_apply_closure_required",
        safety: { sentOrder: false },
        operatorReceipt: {
          operatorApplyVerified: true,
          alreadyAppliedVerified: true,
          activeState: "applied_candidate_matches",
          validationCommands: {
            receipt: `pnpm --dir ${repoRoot} capital:trade:adapter-ack-apply-receipt:check`,
          },
          safety: { sentOrder: false },
        },
      },
      direct: directReady,
      armProfile: {
        status: "armed",
        armed: true,
        allowExecutorWrite: true,
        blockers: [],
      },
    });

    expect(report.status).toBe("blocked");
    expect(report.operatorCanExecute).toBe(false);
    expect(report.liveExecutorArmProfile.allowFieldContract).toMatchObject({
      status: "deprecated_alias_only",
      hasRequiredKey: false,
      hasDeprecatedKey: true,
      deprecatedAliasUsed: true,
      explicitFailure: true,
    });
    expect(report.blockers).toContain(
      "liveExecutor:arm-profile-field-contract-deprecated_alias_only",
    );
  });
});
