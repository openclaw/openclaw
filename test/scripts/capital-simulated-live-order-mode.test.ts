import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapitalSimulatedLiveOrderMode } from "../../scripts/openclaw-capital-simulated-live-order-mode.mjs";

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("capital simulated live order mode", () => {
  it("uses current promotion evidence instead of stale promotion state", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-simlive-"));
    const capitalRoot = path.join(tmpDir, "capital-service");
    const stateDir = path.join(tmpDir, "reports", "hermes-agent", "state");
    const tradingDir = path.join(tmpDir, ".openclaw", "trading");
    try {
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
        safety: {
          allowLiveTrading: false,
          writeBrokerOrders: false,
        },
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
      await writeJson(path.join(stateDir, "openclaw-capital-live-strategy-readiness-latest.json"), {
        schema: "openclaw.capital.live-strategy-readiness.v1",
        status: "paper_ready_live_blocked",
        blockers: ["paper-only-test"],
        capabilities: {
          paperStrategyExecution: true,
          liveStrategyExecution: false,
          liveTradingExecution: false,
          brokerWriteExecution: false,
        },
      });
      await writeJson(path.join(capitalRoot, "hft_service_status.json"), {
        status: "running",
        loginStatus: "connected",
        orderInitialized: true,
        orderStats: { sent: 0 },
        riskControls: {
          allowLiveTrading: true,
          writeBrokerOrders: true,
        },
      });
      await writeJson(path.join(tradingDir, "capital-paper-intent-latest.json"), {
        intentId: "paper-intent-1",
        generatedAt: "2026-05-26T00:00:00.000Z",
        symbol: "CN0000",
        symbolName: "A50",
        side: "buy",
        orderType: "paper_limit",
        quantity: 1,
        price: 15359,
        sourceEvent: {
          eventSource: "test",
          receivedAt: "2026-05-26T00:00:00.000Z",
          close: 15359,
        },
      });
      await writeJson(path.join(stateDir, "openclaw-capital-direct-operation-status-latest.json"), {
        schema: "openclaw.capital.direct-operation-status.v1",
        summary: {
          requestedTrade: {
            instrument: "A50 202605",
            quoteSymbol: "CN0000",
            holdingMode: "day_trade",
            orderApi: "SendOverseaFutureOrder",
          },
        },
      });

      const result = await buildCapitalSimulatedLiveOrderMode({
        repoRoot: tmpDir,
        capitalRoot,
      });

      expect(result.prerequisites.livePromotion.status).toBe("live_ready");
      expect(result.prerequisites.livePromotion.blockers).not.toContain(
        "live:paper-promotion-approved",
      );
      expect(result.status).toBe("enabled_simulated_live");
      expect(result.blockers).not.toContain("live-broker-write-is-enabled");
      expect(result.blockers).not.toContain("live-promotion-gate-state-unexpected");
      expect(result.blockers).not.toContain("live:paper-promotion-approved");
      expect(result.warnings).toContain("service-live-write-enabled-observed");
      expect(result.simulatedOrder?.dayTradeMode).toBe("day_trade");
      expect(result.safety.sentOrder).toBe(false);
      expect(result.safety.noLiveOrderSent).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
