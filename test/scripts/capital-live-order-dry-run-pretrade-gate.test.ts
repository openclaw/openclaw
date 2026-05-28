import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapitalLiveOrderDryRunPretradeGate } from "../../scripts/openclaw-capital-live-order-dry-run-pretrade-gate.mjs";

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("capital live order dry-run pretrade gate", () => {
  it("uses current promotion evidence instead of stale diagnostics blockers", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-pretrade-"));
    const capitalRoot = path.join(tmpDir, "capital-service");
    const stateDir = path.join(tmpDir, "reports", "hermes-agent", "state");
    const tradingDir = path.join(tmpDir, ".openclaw", "trading");
    try {
      await writeJson(
        path.join(stateDir, "openclaw-capital-simulated-live-order-mode-latest.json"),
        {
          schema: "openclaw.capital.simulated-live-order-mode.v1",
          status: "enabled_simulated_live",
          simulatedOrder: {
            intentId: "dryrun-intent",
            wouldUseBrokerApi: "SendOverseaFutureOrder",
            symbol: "CN0000",
            side: "buy",
            orderType: "limit",
            dayTradeMode: "day_trade",
            price: 15359,
            quantity: 1,
            accountAllowlist: { count: 1, source: "test", valuesRedacted: true, sha256: "x" },
          },
          safety: { sentOrder: false, writeBrokerOrders: false },
        },
      );
      await writeJson(path.join(stateDir, "openclaw-capital-simulation-diagnostics-latest.json"), {
        schema: "openclaw.capital.simulation-diagnostics.v1",
        status: "simulation_errors_found",
        hardBlockers: [
          { id: "risk:negative-p05-pnl", severity: "high" },
          { id: "live:human-approval-pending", severity: "high" },
        ],
      });
      await writeJson(
        path.join(stateDir, "openclaw-capital-live-trading-promotion-gate-latest.json"),
        {
          schema: "openclaw.capital.live-trading-promotion-gate.v1",
          status: "blocked",
          readyForManualReview: false,
          blockers: ["live:paper-promotion-approved"],
        },
      );
      await writeJson(path.join(stateDir, "openclaw-capital-angry-bohr-merge-map-latest.json"), {
        schema: "openclaw.capital.angry-bohr-merge-map.v1",
        liveWritePromotionGate: {
          status: "blocked",
          enabled: false,
          blockerCode: "LIVE_WRITE_FORBIDDEN_IN_AUTOMATION",
        },
      });
      await writeJson(path.join(tradingDir, "capital-paper-promotion-gate.json"), {
        status: "passed",
        promoted: true,
        summary: { paperEligible: true },
      });
      await writeJson(path.join(tmpDir, "config", "capital-live-trading-approval.json"), {
        humanApproved: true,
        killSwitch: true,
        rollbackPlan: "test rollback",
        accountAllowlist: ["masked-account"],
      });
      await writeJson(path.join(stateDir, "openclaw-capital-thousand-run-simulation-latest.json"), {
        schema: "openclaw.capital.thousand-run-simulation.v1",
        recommendation: "paper_only_risk_gates_enforced",
        summary: { runs: 1000 },
        safety: {
          liveTradingEnabled: false,
          writeBrokerOrders: false,
          liveTradingExecution: false,
          brokerWriteExecution: false,
          noLiveOrderSent: true,
        },
      });
      await writeJson(
        path.join(stateDir, "openclaw-capital-full-chain-simulation-gate-latest.json"),
        {
          schema: "openclaw.capital.full-chain-simulation-gate.v1",
          status: "passed",
          summary: { runs: 1000, stageFailedCount: 0, faultFailedCount: 0 },
          safety: { liveTradingEnabled: false, writeBrokerOrders: false, noLiveOrderSent: true },
        },
      );
      await writeJson(path.join(stateDir, "openclaw-capital-qmd-walk-forward-gate-latest.json"), {
        schema: "openclaw.capital.qmd-walk-forward-gate.v1",
        status: "passed",
        safety: { liveTradingEnabled: false, writeBrokerOrders: false, sentOrder: false },
      });
      await writeJson(path.join(capitalRoot, "hft_service_status.json"), {
        status: "running",
        loginStatus: "connected",
        orderInitialized: true,
        orderStats: { sent: 0 },
      });
      await writeJson(path.join(capitalRoot, "risk-controls.json"), {
        allowLiveTrading: true,
        writeBrokerOrders: true,
      });
      await writeJson(path.join(tradingDir, "capital-external-broker-adapter-ack.json"), {
        schema: "openclaw.capital.external-broker-adapter-ack.v1",
        adapterId: "operator-capital-live-adapter",
        owner: "operator",
        sealedIntentSha256: "OLD_INTENT",
        canary: { status: "pass", dryRun: true, sentOrder: false },
        rollback: { status: "pass", verifiedAt: "2026-05-25T00:00:00.000Z" },
      });

      const result = await buildCapitalLiveOrderDryRunPretradeGate({
        repoRoot: tmpDir,
        capitalRoot,
      });

      expect(result.inputs.promotionStatus).toBe("live_ready");
      expect(result.preTradeRiskGate.blockers).toContain("agent-broker-write-disabled");
      expect(result.preTradeRiskGate.blockers).not.toContain("risk:negative-p05-pnl");
      expect(result.preTradeRiskGate.blockers).not.toContain("live:human-approval-pending");
      expect(result.preTradeRiskGate.blockers).not.toContain("live:paper-promotion-approved");
      expect(result.preTradeRiskGate.blockers).not.toContain(
        "order:day-trade-mode-explicit-required",
      );
      expect(result.liveOrderDraft.commandPayload.dayTradeMode).toBe("day_trade");
      expect(result.liveOrderDraft.brokerFields.sDayTrade).toBe(1);
      expect(result.operatorHandoff.externalBrokerAdapter.ack.rollbackVerifiedAt).toBe(
        "2026-05-25T00:00:00.000Z",
      );
      expect(result.operatorHandoff.externalBrokerAdapter.ack.template.rollback.verifiedAt).toBe(
        "2026-05-25T00:00:00.000Z",
      );
      expect(result.safety.sentOrder).toBe(false);
      expect(result.safety.noLiveOrderSent).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
