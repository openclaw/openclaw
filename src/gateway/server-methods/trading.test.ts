import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTradingSnapshot,
  readTradingFastOrderAuditSnapshot,
  refreshTradingFastOrderLearningSnapshot,
  reviewTradingFastOrderIntent,
  tradingHandlers,
  writeTradingFastOrderIntent,
} from "./trading.js";

const ORIGINAL_ENV = {
  OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS: process.env.OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS,
  OPENCLAW_ALLOW_PAID_PROVIDER_ACTIONS: process.env.OPENCLAW_ALLOW_PAID_PROVIDER_ACTIONS,
  OPENCLAW_UI_ENABLE_WRITES: process.env.OPENCLAW_UI_ENABLE_WRITES,
  OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS: process.env.OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS,
};

afterEach(() => {
  process.env.OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS =
    ORIGINAL_ENV.OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS;
  process.env.OPENCLAW_ALLOW_PAID_PROVIDER_ACTIONS =
    ORIGINAL_ENV.OPENCLAW_ALLOW_PAID_PROVIDER_ACTIONS;
  process.env.OPENCLAW_UI_ENABLE_WRITES = ORIGINAL_ENV.OPENCLAW_UI_ENABLE_WRITES;
  process.env.OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS =
    ORIGINAL_ENV.OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS;
});

describe("trading gateway methods", () => {
  it("returns paper-only trading snapshot with safety gates and runtime feed counts", async () => {
    process.env.OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS = "0";
    process.env.OPENCLAW_ALLOW_PAID_PROVIDER_ACTIONS = "1";
    process.env.OPENCLAW_UI_ENABLE_WRITES = "true";
    process.env.OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS = "off";

    const respond = vi.fn();
    await tradingHandlers["trading.snapshot"]({
      req: { type: "req", id: "req-1", method: "trading.snapshot", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeSnapshot: () => ({
          channels: {
            telegram: { connected: true, running: true },
            discord: { connected: false, running: true },
          },
          channelAccounts: {
            slack: {
              a: { connected: true, running: true },
              b: { connected: false, running: false },
            },
          },
        }),
      } as never,
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        mode: "paper_only",
        safety: {
          liveTradingEnabled: false,
          paidProviderEnabled: true,
          writesEnabled: true,
          highRiskEnabled: false,
        },
        runtime: {
          totalFeeds: 4,
          connectedFeeds: 2,
          runningFeeds: 3,
        },
        platform: expect.objectContaining({
          fastOrderTicket: expect.objectContaining({
            brokerCommandEnabled: false,
            submissionCommand: "",
          }),
          strategy: expect.objectContaining({
            aiBrainReady: true,
            aiModuleCount: 6,
          }),
        }),
      }),
      undefined,
    );
  });

  it("hydrates AI trading platform state from Capital and OKX reports", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trading-snapshot-"));
    try {
      await fs.mkdir(path.join(repoRoot, "reports", "hermes-agent", "state"), {
        recursive: true,
      });
      await fs.mkdir(path.join(repoRoot, ".openclaw", "trading"), { recursive: true });
      await fs.mkdir(path.join(repoRoot, ".openclaw", "ui"), { recursive: true });
      await fs.writeFile(
        path.join(
          repoRoot,
          "reports",
          "hermes-agent",
          "state",
          "openclaw-capital-full-chain-simulation-gate-latest.json",
        ),
        JSON.stringify({
          schema: "openclaw.capital.full-chain-simulation-gate.v1",
          generatedAt: "2026-05-24T04:44:45.407Z",
          status: "blocked",
          summary: { stageFailedCount: 1, faultFailedCount: 0 },
          blockers: ["quote:domestic-and-overseas-fresh"],
        }),
      );
      await fs.writeFile(
        path.join(repoRoot, ".openclaw", "ui", "auto-trading-assistant-state.json"),
        JSON.stringify({
          fastOrderPaperPattern: {
            pattern: "paper-success",
            successCount: 2,
            failureCount: 0,
            latestStatus: "paper_execution_recorded",
            latestSymbol: "MXFFX999",
            latestSide: "buy",
            latestQuantity: 1,
            historyTotal: 2,
            historyReturned: 2,
            brokerCommandEnabled: false,
            sentBrokerOrder: false,
            submissionCommand: "",
          },
        }),
      );
      await fs.writeFile(
        path.join(
          repoRoot,
          ".openclaw",
          "trading",
          "capital-strategy-engine-full-chain-latest.json",
        ),
        JSON.stringify({
          status: "signals_generated",
          symbol: "TX00",
          quoteSymbol: "TX00AM",
          stats: { signalsGenerated: 11 },
        }),
      );
      await fs.writeFile(
        path.join(repoRoot, ".openclaw", "trading", "capital-strategy-fill-simulation.json"),
        JSON.stringify({
          status: "historical_simulated",
          recommendation: "hold",
          stats: { total_intents: 11 },
        }),
      );
      await fs.writeFile(
        path.join(repoRoot, ".openclaw", "trading", "capital-strategy-intents.jsonl"),
        `${JSON.stringify({
          symbol: "TX00",
          direction: "short",
          quantity: 1,
          price: 40510,
          stopLoss: 40624,
          takeProfit: 40339,
        })}\n`,
      );
      await fs.writeFile(
        path.join(
          repoRoot,
          "reports",
          "hermes-agent",
          "state",
          "openclaw-okx-order-proposal-gate-latest.json",
        ),
        JSON.stringify({
          status: "proposal_ready_blocked_for_execution",
          blockers: [],
          summary_zh_tw: "OKX dry-run 下單提案可供人工審核；實際送單仍停用。",
        }),
      );

      process.env.OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS = "0";
      process.env.OPENCLAW_UI_ENABLE_WRITES = "0";
      process.env.OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS = "0";

      const snapshot = await buildTradingSnapshot({ channels: {}, channelAccounts: {} }, repoRoot);

      expect(snapshot.platform.status).toBe("ready_for_review");
      expect(snapshot.platform.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "capital", blockerCount: 1 }),
          expect.objectContaining({ id: "okx", ready: true }),
        ]),
      );
      expect(snapshot.platform.strategy).toMatchObject({
        symbol: "TX00",
        quoteSymbol: "TX00AM",
        signalsGenerated: 11,
        intentsReady: 11,
        aiBrainReady: true,
        aiModuleCount: 6,
      });
      expect(snapshot.platform.fastOrderTicket).toMatchObject({
        provider: "capital",
        symbol: "TX00",
        side: "short",
        entry: "limit@40510",
        exit: "SL=40624 TP=40339",
        brokerCommandEnabled: false,
        submissionCommand: "",
        liveOrderAllowed: false,
      });
      expect(snapshot.platform.fastOrderPaperPattern).toMatchObject({
        pattern: "paper-success",
        successCount: 2,
        failureCount: 0,
        latestStatus: "paper_execution_recorded",
        latestSymbol: "MXFFX999",
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes Telegram fast order intent to OpenClaw state without broker submission", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trading-intent-"));
    try {
      const snapshot = await buildTradingSnapshot({ channels: {}, channelAccounts: {} }, repoRoot);
      const result = await writeTradingFastOrderIntent(snapshot, repoRoot);
      const jsonlPath = path.join(
        repoRoot,
        ".openclaw",
        "trading",
        "telegram-fast-order-intents.jsonl",
      );
      const reportPath = path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-telegram-fast-order-intent-latest.json",
      );
      const jsonl = await fs.readFile(jsonlPath, "utf8");
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));

      expect(result).toMatchObject({
        schema: "openclaw.trading.fast-order-intent.v1",
        status: "written_broker_locked",
        source: "telegram.ai-platform",
        brokerCommandEnabled: false,
        submissionCommand: "",
        sentBrokerOrder: false,
      });
      expect(result.ticket).toMatchObject({
        brokerCommandEnabled: false,
        submissionCommand: "",
        executionAllowed: false,
        liveOrderAllowed: false,
      });
      expect(result.blockers).toEqual(
        expect.arrayContaining(["broker-command-disabled", "telegram-manual-review-required"]),
      );
      expect(jsonl.trim().split(/\r?\n/u)).toHaveLength(1);
      expect(JSON.parse(jsonl.trim())).toMatchObject({ intentId: result.intentId });
      expect(report).toMatchObject({
        intentId: result.intentId,
        sentBrokerOrder: false,
        writeTargets: {
          jsonl: ".openclaw/trading/telegram-fast-order-intents.jsonl",
          latestReport:
            "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
        },
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("approves latest fast order intent into paper execution audit only", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trading-review-"));
    try {
      const snapshot = await buildTradingSnapshot({ channels: {}, channelAccounts: {} }, repoRoot);
      const intent = await writeTradingFastOrderIntent(snapshot, repoRoot);
      const result = await reviewTradingFastOrderIntent("approve_paper", repoRoot);
      const reviewPath = path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-telegram-fast-order-review-latest.json",
      );
      const paperPath = path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-telegram-fast-order-paper-execution-latest.json",
      );
      const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
      const paperExecution = JSON.parse(await fs.readFile(paperPath, "utf8"));

      expect(result).toMatchObject({
        schema: "openclaw.trading.fast-order-review.v1",
        status: "paper_execution_recorded",
        decision: "approve_paper",
        intentId: intent.intentId,
        mode: "paper_only",
        audit: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
        },
      });
      expect(result.paperExecution).toMatchObject({
        recorded: true,
        paperOnly: true,
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
        submissionCommand: "",
      });
      expect(review).toMatchObject({
        intentId: intent.intentId,
        status: "paper_execution_recorded",
      });
      expect(paperExecution).toMatchObject({
        paperOnly: true,
        sentBrokerOrder: false,
        brokerCommandEnabled: false,
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("records deny decision without paper execution or broker submission", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trading-deny-"));
    try {
      const snapshot = await buildTradingSnapshot({ channels: {}, channelAccounts: {} }, repoRoot);
      const intent = await writeTradingFastOrderIntent(snapshot, repoRoot);
      const result = await reviewTradingFastOrderIntent("deny", repoRoot);

      expect(result).toMatchObject({
        status: "denied",
        decision: "deny",
        intentId: intent.intentId,
        audit: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
          reason: "Telegram deny recorded; no paper execution and no broker order.",
        },
      });
      expect(result.paperExecution).toBeUndefined();
      await expect(
        fs.readFile(
          path.join(
            repoRoot,
            "reports",
            "hermes-agent",
            "state",
            "openclaw-telegram-fast-order-paper-execution-latest.json",
          ),
          "utf8",
        ),
      ).rejects.toThrow();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("reads latest fast order audit snapshot for Telegram query panels", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trading-audit-"));
    try {
      const snapshot = await buildTradingSnapshot({ channels: {}, channelAccounts: {} }, repoRoot);
      const intent = await writeTradingFastOrderIntent(snapshot, repoRoot);
      await reviewTradingFastOrderIntent("approve_paper", repoRoot);
      await fs.mkdir(path.join(repoRoot, ".openclaw", "ui"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".openclaw", "ui", "auto-trading-assistant-state.json"),
        JSON.stringify({
          summary: {
            fastOrderPaperPattern: {
              pattern: "paper-success",
              successCount: 1,
              failureCount: 0,
              latestStatus: "paper_execution_recorded",
              latestSymbol: "TX00",
              latestSide: "wait",
              latestQuantity: 1,
              historyTotal: 3,
              historyReturned: 3,
            },
          },
        }),
      );
      const audit = await readTradingFastOrderAuditSnapshot(repoRoot);

      expect(audit).toMatchObject({
        schema: "openclaw.trading.fast-order-audit-snapshot.v1",
        status: "loaded",
        safety: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
        },
        latestIntent: { intentId: intent.intentId, sentBrokerOrder: false },
        latestReview: {
          intentId: intent.intentId,
          status: "paper_execution_recorded",
          audit: {
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          },
        },
        latestPaperExecution: {
          paperOnly: true,
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
        },
        fastOrderPaperPattern: {
          pattern: "paper-success",
          successCount: 1,
          failureCount: 0,
          latestStatus: "paper_execution_recorded",
          brokerCommandEnabled: false,
          sentBrokerOrder: false,
          submissionCommand: "",
        },
      });
      expect(audit.readTargets).toMatchObject({
        latestIntent: "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json",
        latestReview: "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json",
        latestPaperExecution:
          "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json",
        intentsJsonl: ".openclaw/trading/telegram-fast-order-intents.jsonl",
        reviewsJsonl: ".openclaw/trading/telegram-fast-order-review-decisions.jsonl",
        paperExecutionsJsonl: ".openclaw/trading/telegram-fast-order-paper-executions.jsonl",
      });
      expect(audit.history).toMatchObject({
        filter: "all",
        offset: 0,
        limit: 5,
        total: 3,
        returned: 3,
        hasPrevious: false,
        hasNext: false,
      });
      expect(audit.history.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "intent",
            intentId: intent.intentId,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          }),
          expect.objectContaining({
            kind: "review",
            decision: "approve_paper",
            intentId: intent.intentId,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          }),
          expect.objectContaining({
            kind: "paper_execution",
            decision: "approve_paper",
            intentId: intent.intentId,
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
          }),
        ]),
      );

      const paperAudit = await readTradingFastOrderAuditSnapshot(repoRoot, {
        filter: "paper",
        offset: 0,
        limit: 2,
      });
      expect(paperAudit.history).toMatchObject({
        filter: "paper",
        total: 2,
        returned: 2,
        hasNext: false,
      });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns refresh_failed when paper-loop learning snapshot prerequisites are missing", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-trading-learning-refresh-"));
    try {
      await fs.mkdir(path.join(repoRoot, ".openclaw", "ui"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json"),
        JSON.stringify({
          schema: "openclaw.capital.auto-trading-watch-state.v1",
          status: "test-watch-state",
        }),
      );
      const result = await refreshTradingFastOrderLearningSnapshot(repoRoot);
      const watchState = JSON.parse(
        await fs.readFile(
          path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json"),
          "utf8",
        ),
      );
      expect(result).toMatchObject({
        schema: "openclaw.trading.fast-order-learning-refresh.v1",
        status: "refresh_failed",
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
        watchStateSync: {
          status: "synced",
        },
      });
      expect(watchState.telegramPaperLoopLearningRefresh).toMatchObject({
        status: "refresh_failed",
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
      });
      expect(result.snapshotPath).toContain(".openclaw");
      expect(result.summaryPath).toContain(".openclaw");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
