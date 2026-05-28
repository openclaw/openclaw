import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlers } from "./types.js";

export type TradingSnapshotSafety = {
  liveTradingEnabled: boolean;
  paidProviderEnabled: boolean;
  writesEnabled: boolean;
  highRiskEnabled: boolean;
};

export type TradingSnapshotRuntime = {
  totalFeeds: number;
  connectedFeeds: number;
  runningFeeds: number;
};

export type TradingProviderSnapshot = {
  id: "capital" | "okx";
  label: string;
  status: string;
  ready: boolean;
  blockerCount: number;
  blockers: string[];
  summary: string;
  reportPath: string;
  generatedAt: string;
};

export type TradingOkxLifecycleSnapshot = {
  status: string;
  code: string;
  summary: string;
  simulationCode: string;
  simulationStatus: string;
  simulatedClientOrderId: string;
  submittedOrder: boolean;
  exchangeWriteAttempted: boolean;
  cancelSubmitted: boolean;
  blockers: string[];
  reportPath: string;
  generatedAt: string;
};

export type TradingOkxPaperAuditSummarySnapshot = {
  status: string;
  code: string;
  summary: string;
  totalEntries: number;
  latestStatus: string;
  latestCode: string;
  allEntriesSafe: boolean;
  submittedOrderCount: number;
  exchangeWriteAttemptedCount: number;
  orderStatusQueryExecutedCount: number;
  cancelSubmittedCount: number;
  blockers: string[];
  reportPath: string;
  generatedAt: string;
};

export type TradingStrategySnapshot = {
  status: string;
  symbol: string;
  quoteSymbol: string;
  signalsGenerated: number;
  intentsReady: number;
  fillStatus: string;
  fillRecommendation: string;
  aiBrainReady: boolean;
  aiModuleCount: number;
};

export type TradingFastOrderTicket = {
  provider: "capital";
  mode: "gated_live_ticket";
  symbol: string;
  side: string;
  quantity: number;
  entry: string;
  exit: string;
  brokerApi: string;
  executionAllowed: boolean;
  liveOrderAllowed: boolean;
  brokerCommandEnabled: false;
  submissionCommand: "";
  blockerCount: number;
  blockers: string[];
  nextCommand: string;
};

export type TradingFastOrderPaperPatternSnapshot = {
  pattern: string;
  successCount: number;
  failureCount: number;
  latestStatus: string;
  latestSymbol: string;
  latestSide: string;
  latestQuantity: number;
  historyTotal: number;
  historyReturned: number;
  brokerCommandEnabled: false;
  sentBrokerOrder: false;
  submissionCommand: "";
  readTargets: {
    autoTradingAssistant: string;
    capitalPaperAssistant: string;
  };
};

export type TradingPlatformSnapshot = {
  status: "ready_for_review" | "waiting_market" | "blocked" | "not_configured";
  title: string;
  providers: TradingProviderSnapshot[];
  okxLifecycle: TradingOkxLifecycleSnapshot;
  okxPaperAuditSummary: TradingOkxPaperAuditSummarySnapshot;
  strategy: TradingStrategySnapshot;
  fastOrderTicket: TradingFastOrderTicket;
  fastOrderPaperPattern: TradingFastOrderPaperPatternSnapshot;
  reports: {
    capitalFullChain: string;
    capitalStrategy: string;
    capitalFill: string;
    capitalPromotion: string;
    okxProposal: string;
    okxStatus: string;
    okxPaperAuditSummary: string;
  };
};

export type TradingSnapshotResult = {
  ts: number;
  mode: "paper_only";
  safety: TradingSnapshotSafety;
  runtime: TradingSnapshotRuntime;
  platform: TradingPlatformSnapshot;
};

export type TradingFastOrderIntentWriteResult = {
  schema: "openclaw.trading.fast-order-intent.v1";
  generatedAt: string;
  status: "written_broker_locked";
  intentId: string;
  source: "telegram.ai-platform";
  mode: "paper_only";
  ticket: TradingFastOrderTicket;
  safety: TradingSnapshotSafety;
  blockers: string[];
  brokerCommandEnabled: false;
  submissionCommand: "";
  sentBrokerOrder: false;
  writeTargets: {
    jsonl: string;
    latestReport: string;
  };
  nextSafeTask: string;
};

export type TradingFastOrderIntentReviewResult = {
  schema: "openclaw.trading.fast-order-review.v1";
  generatedAt: string;
  status: "paper_execution_recorded" | "denied" | "missing_intent";
  decision: "approve_paper" | "deny";
  intentId: string;
  source: "telegram.fast-order-review";
  mode: "paper_only";
  ticket?: TradingFastOrderTicket;
  paperExecution?: {
    generatedAt?: string;
    intentId?: string;
    status?: "paper_execution_recorded";
    recorded: boolean;
    paperOnly: true;
    symbol: string;
    side: string;
    quantity: number;
    entry: string;
    exit: string;
    brokerApi: string;
    sentBrokerOrder: false;
    brokerCommandEnabled: false;
    submissionCommand: "";
  };
  audit: {
    sentBrokerOrder: false;
    brokerCommandEnabled: false;
    submissionCommand: "";
    blockers: string[];
    reason: string;
  };
  writeTargets: {
    reviewJsonl: string;
    latestReview: string;
    paperExecutionJsonl?: string;
    latestPaperExecution?: string;
  };
  nextSafeTask: string;
};

export type TradingFastOrderAuditHistoryFilter = "all" | "intent" | "review" | "paper" | "denied";

export type TradingFastOrderAuditHistoryEntry = {
  kind: "intent" | "review" | "paper_execution";
  generatedAt: string;
  intentId: string;
  status: string;
  decision?: "approve_paper" | "deny";
  symbol: string;
  side: string;
  quantity: number;
  paperOnly: true;
  sentBrokerOrder: false;
  brokerCommandEnabled: false;
  submissionCommand: "";
  sourcePath: string;
};

export type TradingFastOrderAuditHistoryQuery = {
  filter?: TradingFastOrderAuditHistoryFilter;
  offset?: number;
  limit?: number;
};

export type TradingFastOrderAuditSnapshot = {
  schema: "openclaw.trading.fast-order-audit-snapshot.v1";
  generatedAt: string;
  status: "loaded" | "empty";
  latestIntent: TradingFastOrderIntentWriteResult | null;
  latestReview: TradingFastOrderIntentReviewResult | null;
  latestPaperExecution: JsonRecord | null;
  fastOrderPaperPattern: TradingFastOrderPaperPatternSnapshot;
  safety: {
    sentBrokerOrder: false;
    brokerCommandEnabled: false;
    submissionCommand: "";
  };
  readTargets: {
    latestIntent: string;
    latestReview: string;
    latestPaperExecution: string;
    intentsJsonl: string;
    reviewsJsonl: string;
    paperExecutionsJsonl: string;
  };
  history: {
    filter: TradingFastOrderAuditHistoryFilter;
    offset: number;
    limit: number;
    total: number;
    returned: number;
    hasPrevious: boolean;
    hasNext: boolean;
    filters: TradingFastOrderAuditHistoryFilter[];
    entries: TradingFastOrderAuditHistoryEntry[];
  };
  nextSafeTask: string;
};

export type TradingFastOrderLearningSnapshotRefreshResult = {
  schema: "openclaw.trading.fast-order-learning-refresh.v1";
  generatedAt: string;
  status: "refreshed" | "refresh_failed";
  snapshotPath: string;
  summaryPath: string;
  assistantFastOrderPaperPattern: string;
  fastOrderPaperPattern: TradingFastOrderPaperPatternSnapshot;
  brokerCommandEnabled: false;
  sentBrokerOrder: false;
  submissionCommand: "";
  nextSafeTask: string;
  readTargets: {
    script: string;
    snapshot: string;
    summary: string;
  };
  watchStateSync?: {
    status: "synced" | "missing_watch_state" | "invalid_watch_state" | "sync_failed";
    watchStatePath: string;
    error?: string;
  };
  error?: string;
};

type JsonRecord = Record<string, unknown>;

const FAST_ORDER_INTENTS_JSONL = ".openclaw/trading/telegram-fast-order-intents.jsonl";
const FAST_ORDER_REVIEWS_JSONL = ".openclaw/trading/telegram-fast-order-review-decisions.jsonl";
const FAST_ORDER_PAPER_EXECUTIONS_JSONL =
  ".openclaw/trading/telegram-fast-order-paper-executions.jsonl";
const FAST_ORDER_LATEST_INTENT =
  "reports/hermes-agent/state/openclaw-telegram-fast-order-intent-latest.json";
const FAST_ORDER_LATEST_REVIEW =
  "reports/hermes-agent/state/openclaw-telegram-fast-order-review-latest.json";
const FAST_ORDER_LATEST_PAPER_EXECUTION =
  "reports/hermes-agent/state/openclaw-telegram-fast-order-paper-execution-latest.json";
const AUTO_TRADING_ASSISTANT_STATE = ".openclaw/ui/auto-trading-assistant-state.json";
const CAPITAL_PAPER_ASSISTANT_STATE = ".openclaw/ui/capital-paper-assistant-state.json";
const AUTO_TRADING_LEARNING_SNAPSHOT_SCRIPT = "scripts/openclaw-auto-trading-learning-snapshot.mjs";
const AUTO_TRADING_LEARNING_SNAPSHOT_REPORT = ".openclaw/ui/auto-trading-learning-snapshot.json";
const AUTO_TRADING_LEARNING_SUMMARY_REPORT = ".openclaw/ui/auto-trading-learning-summary.md";
const AUTO_TRADING_WATCH_STATE_REPORT = ".openclaw/ui/auto-trading-watch-state.json";
const FAST_ORDER_AUDIT_FILTERS: TradingFastOrderAuditHistoryFilter[] = [
  "all",
  "intent",
  "review",
  "paper",
  "denied",
];

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveSafety(): TradingSnapshotSafety {
  const env = process.env;
  // Environment gates are authoritative at runtime for the Control UI action broker.
  return {
    liveTradingEnabled: isTruthyFlag(env.OPENCLAW_ALLOW_LIVE_TRADING_UI_ACTIONS),
    paidProviderEnabled: isTruthyFlag(env.OPENCLAW_ALLOW_PAID_PROVIDER_ACTIONS),
    writesEnabled: isTruthyFlag(env.OPENCLAW_UI_ENABLE_WRITES),
    highRiskEnabled: isTruthyFlag(env.OPENCLAW_ALLOW_HIGH_RISK_UI_ACTIONS),
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function valueAt(source: unknown, keys: string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function stringAt(source: unknown, keys: string[], fallback = ""): string {
  const value = valueAt(source, keys);
  return typeof value === "string" ? value : fallback;
}

function numberAt(source: unknown, keys: string[], fallback = 0): number {
  const value = valueAt(source, keys);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function scalarText(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function booleanAt(source: unknown, keys: string[], fallback = false): boolean {
  const value = valueAt(source, keys);
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayAt(source: unknown, keys: string[]): string[] {
  const value = valueAt(source, keys);
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function readJsonReport(repoRoot: string, relativePath: string): Promise<JsonRecord | null> {
  try {
    return asRecord(
      JSON.parse(
        (await fs.readFile(path.join(repoRoot, relativePath), "utf8")).replace(/^\uFEFF/u, ""),
      ),
    );
  } catch {
    return null;
  }
}

async function readLatestJsonLine(
  repoRoot: string,
  relativePath: string,
): Promise<JsonRecord | null> {
  try {
    const lines = (await fs.readFile(path.join(repoRoot, relativePath), "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return asRecord(JSON.parse(lines[index]));
      } catch {
        // Ignore partial or corrupt stream lines and keep scanning older evidence.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readLatestJsonLines(
  repoRoot: string,
  relativePath: string,
  limit = 40,
): Promise<JsonRecord[]> {
  try {
    const lines = (await fs.readFile(path.join(repoRoot, relativePath), "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const records: JsonRecord[] = [];
    for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
      try {
        records.push(asRecord(JSON.parse(lines[index])));
      } catch {
        // Ignore partial or corrupt stream lines and keep scanning older evidence.
      }
    }
    return records;
  } catch {
    return [];
  }
}

function stableIntentId(generatedAt: string, ticket: TradingFastOrderTicket): string {
  return [
    generatedAt.replaceAll(/[^0-9A-Za-z]/gu, "").slice(0, 18),
    ticket.provider,
    ticket.symbol.replaceAll(/[^0-9A-Za-z]/gu, "").slice(0, 12) || "symbol",
    ticket.side.replaceAll(/[^0-9A-Za-z]/gu, "").slice(0, 12) || "side",
  ].join("-");
}

function normalizeFastOrderTicket(value: unknown): TradingFastOrderTicket | null {
  const record = asRecord(value);
  if (!record.symbol) {
    return null;
  }
  const rawBlockers = Array.isArray(record.blockers)
    ? record.blockers.map((item) => String(item)).filter(Boolean)
    : [];
  return {
    provider: "capital",
    mode: "gated_live_ticket",
    symbol: stringAt(record, ["symbol"], "TX00"),
    side: stringAt(record, ["side"], "wait"),
    quantity: numberAt(record, ["quantity"], 1),
    entry: stringAt(record, ["entry"], "waiting_price"),
    exit: stringAt(record, ["exit"], "waiting_exit_rule"),
    brokerApi: stringAt(
      record,
      ["brokerApi"],
      inferBrokerApi(stringAt(record, ["symbol"], "TX00")),
    ),
    executionAllowed: false,
    liveOrderAllowed: false,
    brokerCommandEnabled: false,
    submissionCommand: "",
    blockerCount: rawBlockers.length,
    blockers: rawBlockers,
    nextCommand: stringAt(record, ["nextCommand"], "capital-hft:capital:full-chain"),
  };
}

function normalizeFastOrderPaperPattern(value: unknown): TradingFastOrderPaperPatternSnapshot {
  const record = asRecord(value);
  return {
    pattern: stringAt(record, ["pattern"], "no-paper-execution"),
    successCount: numberAt(record, ["successCount"]),
    failureCount: numberAt(record, ["failureCount"]),
    latestStatus: stringAt(record, ["latestStatus"], "none"),
    latestSymbol: stringAt(record, ["latestSymbol"], "TX00"),
    latestSide: stringAt(record, ["latestSide"], "wait"),
    latestQuantity: numberAt(record, ["latestQuantity"], 1),
    historyTotal: numberAt(record, ["historyTotal"]),
    historyReturned: numberAt(record, ["historyReturned"]),
    brokerCommandEnabled: false,
    sentBrokerOrder: false,
    submissionCommand: "",
    readTargets: {
      autoTradingAssistant: AUTO_TRADING_ASSISTANT_STATE,
      capitalPaperAssistant: CAPITAL_PAPER_ASSISTANT_STATE,
    },
  };
}

async function readAssistantFastOrderPaperPattern(
  repoRoot: string,
): Promise<TradingFastOrderPaperPatternSnapshot> {
  const [autoTradingAssistant, capitalPaperAssistant] = await Promise.all([
    readJsonReport(repoRoot, AUTO_TRADING_ASSISTANT_STATE),
    readJsonReport(repoRoot, CAPITAL_PAPER_ASSISTANT_STATE),
  ]);
  const autoPattern =
    valueAt(autoTradingAssistant, ["fastOrderPaperPattern"]) ??
    valueAt(autoTradingAssistant, ["summary", "fastOrderPaperPattern"]);
  const capitalPattern =
    valueAt(capitalPaperAssistant, ["fastOrderPaperPattern"]) ??
    valueAt(capitalPaperAssistant, ["summary", "fastOrderPaperPattern"]) ??
    valueAt(capitalPaperAssistant, ["learning", "fastOrderPaperPattern"]) ??
    valueAt(capitalPaperAssistant, ["chartStrategy", "fastOrderPaperPattern"]);
  return normalizeFastOrderPaperPattern(autoPattern ?? capitalPattern);
}

function summarizeCapitalProvider(fullChain: JsonRecord | null): TradingProviderSnapshot {
  const blockers = stringArrayAt(fullChain, ["blockers"]);
  const status = stringAt(fullChain, ["status"], fullChain ? "unknown" : "missing");
  const stageFailed = numberAt(fullChain, ["summary", "stageFailedCount"]);
  const faultFailed = numberAt(fullChain, ["summary", "faultFailedCount"]);
  return {
    id: "capital",
    label: "Capital",
    status,
    ready: status === "passed",
    blockerCount: blockers.length,
    blockers,
    summary:
      status === "passed"
        ? "Capital full-chain dry-run passed; live still requires approval gate."
        : `Capital full-chain blocked: stage=${stageFailed}, fault=${faultFailed}.`,
    reportPath:
      "reports/hermes-agent/state/openclaw-capital-full-chain-simulation-gate-latest.json",
    generatedAt: stringAt(fullChain, ["generatedAt"]),
  };
}

function summarizeOkxProvider(okxProposal: JsonRecord | null): TradingProviderSnapshot {
  const blockers = stringArrayAt(okxProposal, ["blockers"]);
  const status = stringAt(okxProposal, ["status"], okxProposal ? "unknown" : "missing");
  return {
    id: "okx",
    label: "OKX",
    status,
    ready: blockers.length === 0 && status !== "missing",
    blockerCount: blockers.length,
    blockers,
    summary:
      stringAt(okxProposal, ["summary_zh_tw"]) ||
      (okxProposal ? "OKX dry-run proposal gate loaded." : "OKX proposal gate report missing."),
    reportPath: "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json",
    generatedAt: stringAt(okxProposal, ["generatedAt"]),
  };
}

function summarizeOkxLifecycle(okxStatus: JsonRecord | null): TradingOkxLifecycleSnapshot {
  const demoSimulation = asRecord(okxStatus?.demoSimulation);
  const simulatedOrder = asRecord(demoSimulation?.simulatedOrder);
  const simulatedCancel = asRecord(demoSimulation?.simulatedCancel);
  return {
    status: stringAt(okxStatus, ["status"], okxStatus ? "unknown" : "missing"),
    code: stringAt(okxStatus, ["code"], okxStatus ? "unknown" : "missing"),
    summary:
      stringAt(okxStatus, ["summary_zh_tw"]) ||
      (okxStatus ? "OKX order-status gate loaded." : "OKX order-status gate report missing."),
    simulationCode: stringAt(demoSimulation, ["code"], "missing"),
    simulationStatus: stringAt(demoSimulation, ["status"], "missing"),
    simulatedClientOrderId: stringAt(simulatedOrder, ["simulatedClientOrderId"]),
    submittedOrder: booleanAt(simulatedOrder, ["submittedOrder"]),
    exchangeWriteAttempted: booleanAt(simulatedOrder, ["exchangeWriteAttempted"]),
    cancelSubmitted: booleanAt(simulatedCancel, ["cancelSubmitted"]),
    blockers: stringArrayAt(okxStatus, ["blockers"]),
    reportPath: "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json",
    generatedAt: stringAt(okxStatus, ["generatedAt"]),
  };
}

function summarizeOkxPaperAuditSummary(
  okxPaperAuditSummary: JsonRecord | null,
): TradingOkxPaperAuditSummarySnapshot {
  const latestEntry = asRecord(okxPaperAuditSummary?.latestEntry);
  const safetyAggregate = asRecord(okxPaperAuditSummary?.safetyAggregate);
  return {
    status: stringAt(
      okxPaperAuditSummary,
      ["status"],
      okxPaperAuditSummary ? "unknown" : "missing",
    ),
    code: stringAt(okxPaperAuditSummary, ["code"], okxPaperAuditSummary ? "unknown" : "missing"),
    summary:
      stringAt(okxPaperAuditSummary, ["summary_zh_tw"]) ||
      (okxPaperAuditSummary
        ? "OKX paper audit summary gate loaded."
        : "OKX paper audit summary report missing."),
    totalEntries: numberAt(okxPaperAuditSummary, ["counts", "totalEntries"]),
    latestStatus: stringAt(latestEntry, ["status"], "none"),
    latestCode: stringAt(latestEntry, ["code"], "none"),
    allEntriesSafe: booleanAt(safetyAggregate, ["allEntriesSafe"]),
    submittedOrderCount: numberAt(safetyAggregate, ["submittedOrder"]),
    exchangeWriteAttemptedCount: numberAt(safetyAggregate, ["exchangeWriteAttempted"]),
    orderStatusQueryExecutedCount: numberAt(safetyAggregate, ["orderStatusQueryExecuted"]),
    cancelSubmittedCount: numberAt(safetyAggregate, ["cancelSubmitted"]),
    blockers: stringArrayAt(okxPaperAuditSummary, ["blockers"]),
    reportPath: "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
    generatedAt: stringAt(okxPaperAuditSummary, ["generatedAt"]),
  };
}

function inferBrokerApi(symbol: string): string {
  return /^(CL|QM|MCL|BZ|CN|CD|GC|MGC|SI|NQ|MNQ|ES|MES|YM|MYM|RTY|M2K)/u.test(symbol.toUpperCase())
    ? "SendOverseaFutureOrder"
    : "SendFutureOrder";
}

function buildStrategySnapshot(
  strategy: JsonRecord | null,
  fill: JsonRecord | null,
): TradingStrategySnapshot {
  return {
    status: stringAt(strategy, ["status"], strategy ? "unknown" : "missing"),
    symbol: stringAt(strategy, ["symbol"], "TX00"),
    quoteSymbol: stringAt(strategy, ["quoteSymbol"]),
    signalsGenerated: numberAt(strategy, ["stats", "signalsGenerated"]),
    intentsReady: numberAt(fill, ["stats", "total_intents"]),
    fillStatus: stringAt(fill, ["status"], fill ? "unknown" : "missing"),
    fillRecommendation: stringAt(fill, ["recommendation"], "hold"),
    aiBrainReady: true,
    aiModuleCount: 6,
  };
}

function buildFastOrderTicket(input: {
  safety: TradingSnapshotSafety;
  fullChain: JsonRecord | null;
  promotion: JsonRecord | null;
  intent: JsonRecord | null;
  strategy: TradingStrategySnapshot;
}): TradingFastOrderTicket {
  const symbol = stringAt(input.intent, ["symbol"], input.strategy.symbol || "TX00");
  const side = stringAt(input.intent, ["side"], stringAt(input.intent, ["direction"], "wait"));
  const quantity = numberAt(input.intent, ["quantity"], 1);
  const price = valueAt(input.intent, ["price"]);
  const stopLoss = valueAt(input.intent, ["stopLoss"]);
  const takeProfit = valueAt(input.intent, ["takeProfit"]);
  const priceLabel = scalarText(price);
  const stopLossLabel = scalarText(stopLoss, "waiting");
  const takeProfitLabel = scalarText(takeProfit, "waiting");
  const blockers = uniqueStrings([
    ...stringArrayAt(input.fullChain, ["blockers"]),
    ...(input.intent ? [] : ["strategy-intent-missing"]),
    ...(booleanAt(input.promotion, ["readyForManualReview"])
      ? []
      : ["live-manual-review-not-ready"]),
    ...(input.safety.liveTradingEnabled ? [] : ["ui-live-trading-locked"]),
    ...(input.safety.writesEnabled ? [] : ["ui-write-actions-locked"]),
    ...(input.safety.highRiskEnabled ? [] : ["ui-high-risk-actions-locked"]),
  ]);
  const liveOrderAllowed =
    blockers.length === 0 &&
    input.safety.liveTradingEnabled &&
    input.safety.writesEnabled &&
    input.safety.highRiskEnabled;

  return {
    provider: "capital",
    mode: "gated_live_ticket",
    symbol,
    side,
    quantity,
    entry: priceLabel.length === 0 ? "waiting_price" : `limit@${priceLabel}`,
    exit:
      stopLoss == null && takeProfit == null
        ? "waiting_exit_rule"
        : `SL=${stopLossLabel} TP=${takeProfitLabel}`,
    brokerApi: inferBrokerApi(symbol),
    executionAllowed: liveOrderAllowed,
    liveOrderAllowed,
    brokerCommandEnabled: false,
    submissionCommand: "",
    blockerCount: blockers.length,
    blockers,
    nextCommand:
      blockers.length === 0
        ? "capital:live-trading:operator:heartbeat:guarded:execute"
        : "capital-hft:capital:full-chain",
  };
}

async function resolveTradingPlatform(
  repoRoot: string,
  safety: TradingSnapshotSafety,
): Promise<TradingPlatformSnapshot> {
  const [
    fullChain,
    strategyFullChain,
    strategyLatest,
    fill,
    promotion,
    okxProposal,
    okxStatus,
    okxPaperAuditSummary,
    latestStrategyIntent,
    latestPaperIntent,
    fastOrderPaperPattern,
  ] = await Promise.all([
    readJsonReport(
      repoRoot,
      "reports/hermes-agent/state/openclaw-capital-full-chain-simulation-gate-latest.json",
    ),
    readJsonReport(repoRoot, ".openclaw/trading/capital-strategy-engine-full-chain-latest.json"),
    readJsonReport(repoRoot, ".openclaw/trading/capital-strategy-engine-latest.json"),
    readJsonReport(repoRoot, ".openclaw/trading/capital-strategy-fill-simulation.json"),
    readJsonReport(
      repoRoot,
      "reports/hermes-agent/state/openclaw-capital-live-trading-promotion-gate-latest.json",
    ),
    readJsonReport(
      repoRoot,
      "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json",
    ),
    readJsonReport(
      repoRoot,
      "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json",
    ),
    readJsonReport(
      repoRoot,
      "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
    ),
    readLatestJsonLine(repoRoot, ".openclaw/trading/capital-strategy-intents.jsonl"),
    readLatestJsonLine(repoRoot, ".openclaw/trading/capital-paper-intents.jsonl"),
    readAssistantFastOrderPaperPattern(repoRoot),
  ]);

  const capital = summarizeCapitalProvider(fullChain);
  const okx = summarizeOkxProvider(okxProposal);
  const okxLifecycle = summarizeOkxLifecycle(okxStatus);
  const okxPaperAuditSummarySnapshot = summarizeOkxPaperAuditSummary(okxPaperAuditSummary);
  const strategy = buildStrategySnapshot(strategyFullChain ?? strategyLatest, fill);
  const fastOrderTicket = buildFastOrderTicket({
    safety,
    fullChain,
    promotion,
    intent: latestPaperIntent ?? latestStrategyIntent,
    strategy,
  });
  const quoteOnlyCapitalBlock =
    capital.blockers.length === 1 && capital.blockers[0] === "quote:domestic-and-overseas-fresh";
  const status: TradingPlatformSnapshot["status"] =
    capital.ready || okx.ready
      ? "ready_for_review"
      : quoteOnlyCapitalBlock
        ? "waiting_market"
        : fullChain || okxProposal
          ? "blocked"
          : "not_configured";

  return {
    status,
    title:
      status === "waiting_market"
        ? "AI trading platform waiting for fresh market quotes"
        : status === "ready_for_review"
          ? "AI trading platform ready for manual review"
          : status === "blocked"
            ? "AI trading platform blocked by gates"
            : "AI trading platform needs state reports",
    providers: [capital, okx],
    okxLifecycle,
    okxPaperAuditSummary: okxPaperAuditSummarySnapshot,
    strategy,
    fastOrderTicket,
    fastOrderPaperPattern,
    reports: {
      capitalFullChain: capital.reportPath,
      capitalStrategy: ".openclaw/trading/capital-strategy-engine-full-chain-latest.json",
      capitalFill: ".openclaw/trading/capital-strategy-fill-simulation.json",
      capitalPromotion:
        "reports/hermes-agent/state/openclaw-capital-live-trading-promotion-gate-latest.json",
      okxProposal: okx.reportPath,
      okxStatus: "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json",
      okxPaperAuditSummary: okxPaperAuditSummarySnapshot.reportPath,
    },
  };
}

function resolveFeedRuntime(snapshot: ChannelRuntimeSnapshot): TradingSnapshotRuntime {
  let totalFeeds = 0;
  let connectedFeeds = 0;
  let runningFeeds = 0;

  const channelIds = new Set([
    ...Object.keys(snapshot.channels ?? {}),
    ...Object.keys(snapshot.channelAccounts ?? {}),
  ]);

  for (const channelId of channelIds) {
    const channelAccounts = snapshot.channelAccounts?.[channelId];
    const accountSnapshots =
      channelAccounts && typeof channelAccounts === "object" ? Object.values(channelAccounts) : [];

    if (accountSnapshots.length > 0) {
      for (const account of accountSnapshots) {
        totalFeeds += 1;
        if (account.connected === true) {
          connectedFeeds += 1;
        }
        if (account.running === true) {
          runningFeeds += 1;
        }
      }
      continue;
    }

    const channel = snapshot.channels?.[channelId];
    if (!channel) {
      continue;
    }
    totalFeeds += 1;
    if (channel.connected === true) {
      connectedFeeds += 1;
    }
    if (channel.running === true) {
      runningFeeds += 1;
    }
  }

  return {
    totalFeeds,
    connectedFeeds,
    runningFeeds,
  };
}

export async function buildTradingSnapshot(
  snapshot: ChannelRuntimeSnapshot,
  repoRoot = process.cwd(),
): Promise<TradingSnapshotResult> {
  const runtime = resolveFeedRuntime(snapshot);
  const safety = resolveSafety();
  return {
    ts: Date.now(),
    mode: "paper_only",
    safety,
    runtime,
    platform: await resolveTradingPlatform(repoRoot, safety),
  };
}

export async function writeTradingFastOrderIntent(
  snapshot: TradingSnapshotResult,
  repoRoot = process.cwd(),
): Promise<TradingFastOrderIntentWriteResult> {
  const generatedAt = new Date().toISOString();
  const ticket = snapshot.platform.fastOrderTicket;
  const blockers = uniqueStrings([
    ...ticket.blockers,
    ...(ticket.liveOrderAllowed ? [] : ["live-order-not-allowed"]),
    "broker-command-disabled",
    "telegram-manual-review-required",
  ]);
  const jsonl = FAST_ORDER_INTENTS_JSONL;
  const latestReport = FAST_ORDER_LATEST_INTENT;
  const record: TradingFastOrderIntentWriteResult = {
    schema: "openclaw.trading.fast-order-intent.v1",
    generatedAt,
    status: "written_broker_locked",
    intentId: stableIntentId(generatedAt, ticket),
    source: "telegram.ai-platform",
    mode: snapshot.mode,
    ticket: {
      ...ticket,
      brokerCommandEnabled: false,
      submissionCommand: "",
      executionAllowed: false,
      liveOrderAllowed: false,
      blockerCount: blockers.length,
      blockers,
    },
    safety: snapshot.safety,
    blockers,
    brokerCommandEnabled: false,
    submissionCommand: "",
    sentBrokerOrder: false,
    writeTargets: {
      jsonl,
      latestReport,
    },
    nextSafeTask:
      "人工審核此 OpenClaw intent；fresh quote、promotion gate 與 explicit live approval 全部通過前不得送 broker order。",
  };

  await fs.mkdir(path.dirname(path.join(repoRoot, jsonl)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(repoRoot, latestReport)), { recursive: true });
  await fs.appendFile(path.join(repoRoot, jsonl), `${JSON.stringify(record)}\n`, "utf8");
  await fs.writeFile(
    path.join(repoRoot, latestReport),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

async function readLatestTradingFastOrderIntent(
  repoRoot = process.cwd(),
): Promise<TradingFastOrderIntentWriteResult | null> {
  const raw = await readJsonReport(repoRoot, FAST_ORDER_LATEST_INTENT);
  return normalizeTradingFastOrderIntent(raw);
}

function normalizeTradingFastOrderIntent(
  raw: JsonRecord | null,
): TradingFastOrderIntentWriteResult | null {
  if (raw?.schema !== "openclaw.trading.fast-order-intent.v1") {
    return null;
  }
  const ticket = normalizeFastOrderTicket(raw.ticket);
  if (!ticket) {
    return null;
  }
  return {
    schema: "openclaw.trading.fast-order-intent.v1",
    generatedAt: stringAt(raw, ["generatedAt"]),
    status: "written_broker_locked",
    intentId: stringAt(raw, ["intentId"], stableIntentId(new Date().toISOString(), ticket)),
    source: "telegram.ai-platform",
    mode: "paper_only",
    ticket,
    safety: asRecord(raw.safety) as TradingSnapshotSafety,
    blockers: stringArrayAt(raw, ["blockers"]),
    brokerCommandEnabled: false,
    submissionCommand: "",
    sentBrokerOrder: false,
    writeTargets: {
      jsonl: FAST_ORDER_INTENTS_JSONL,
      latestReport: FAST_ORDER_LATEST_INTENT,
    },
    nextSafeTask: stringAt(
      raw,
      ["nextSafeTask"],
      "人工審核此 OpenClaw intent；所有 live gate 通過前不得送 broker order。",
    ),
  };
}

async function readLatestTradingFastOrderReview(
  repoRoot = process.cwd(),
): Promise<TradingFastOrderIntentReviewResult | null> {
  const raw = await readJsonReport(repoRoot, FAST_ORDER_LATEST_REVIEW);
  return normalizeTradingFastOrderReview(raw);
}

function normalizeTradingFastOrderReview(
  raw: JsonRecord | null,
): TradingFastOrderIntentReviewResult | null {
  if (raw?.schema !== "openclaw.trading.fast-order-review.v1") {
    return null;
  }
  const ticket = normalizeFastOrderTicket(raw.ticket);
  const paperExecution = asRecord(raw.paperExecution);
  const audit = asRecord(raw.audit);
  const writeTargets = asRecord(raw.writeTargets);
  const decision = stringAt(raw, ["decision"]) === "deny" ? "deny" : "approve_paper";
  const statusRaw = stringAt(raw, ["status"], "missing_intent");
  const status: TradingFastOrderIntentReviewResult["status"] =
    statusRaw === "paper_execution_recorded" || statusRaw === "denied"
      ? statusRaw
      : "missing_intent";
  return {
    schema: "openclaw.trading.fast-order-review.v1",
    generatedAt: stringAt(raw, ["generatedAt"]),
    status,
    decision,
    intentId: stringAt(raw, ["intentId"], "missing"),
    source: "telegram.fast-order-review",
    mode: "paper_only",
    ...(ticket ? { ticket } : {}),
    ...(paperExecution && Object.keys(paperExecution).length > 0
      ? {
          paperExecution: {
            generatedAt: stringAt(paperExecution, ["generatedAt"]),
            intentId: stringAt(paperExecution, ["intentId"]),
            status: "paper_execution_recorded",
            recorded: Boolean(paperExecution.recorded),
            paperOnly: true,
            symbol: stringAt(paperExecution, ["symbol"], ticket?.symbol ?? "TX00"),
            side: stringAt(paperExecution, ["side"], ticket?.side ?? "wait"),
            quantity: numberAt(paperExecution, ["quantity"], ticket?.quantity ?? 1),
            entry: stringAt(paperExecution, ["entry"], ticket?.entry ?? "waiting_price"),
            exit: stringAt(paperExecution, ["exit"], ticket?.exit ?? "waiting_exit_rule"),
            brokerApi: stringAt(
              paperExecution,
              ["brokerApi"],
              ticket?.brokerApi ?? inferBrokerApi(ticket?.symbol ?? "TX00"),
            ),
            sentBrokerOrder: false,
            brokerCommandEnabled: false,
            submissionCommand: "",
          },
        }
      : {}),
    audit: {
      sentBrokerOrder: false,
      brokerCommandEnabled: false,
      submissionCommand: "",
      blockers: stringArrayAt(audit, ["blockers"]),
      reason: stringAt(audit, ["reason"], "無審核原因"),
    },
    writeTargets: {
      reviewJsonl: stringAt(writeTargets, ["reviewJsonl"], FAST_ORDER_REVIEWS_JSONL),
      latestReview: stringAt(writeTargets, ["latestReview"], FAST_ORDER_LATEST_REVIEW),
      paperExecutionJsonl: stringAt(writeTargets, ["paperExecutionJsonl"]),
      latestPaperExecution: stringAt(writeTargets, ["latestPaperExecution"]),
    },
    nextSafeTask: stringAt(
      raw,
      ["nextSafeTask"],
      "檢查 audit；所有 live gate 通過前不得送 broker order。",
    ),
  };
}

function normalizeFastOrderAuditQuery(
  params: unknown,
): Required<TradingFastOrderAuditHistoryQuery> {
  const record = asRecord(params);
  const rawFilter = stringAt(record, ["filter"], "all") as TradingFastOrderAuditHistoryFilter;
  const filter = FAST_ORDER_AUDIT_FILTERS.includes(rawFilter) ? rawFilter : "all";
  const rawOffset = numberAt(record, ["offset"], 0);
  const rawLimit = numberAt(record, ["limit"], 5);
  return {
    filter,
    offset: Math.max(0, Math.trunc(rawOffset)),
    limit: Math.min(8, Math.max(1, Math.trunc(rawLimit))),
  };
}

function compareHistoryEntryDesc(
  left: TradingFastOrderAuditHistoryEntry,
  right: TradingFastOrderAuditHistoryEntry,
): number {
  const leftTime = Date.parse(left.generatedAt);
  const rightTime = Date.parse(right.generatedAt);
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;
  return normalizedRight - normalizedLeft;
}

function matchesFastOrderAuditFilter(
  entry: TradingFastOrderAuditHistoryEntry,
  filter: TradingFastOrderAuditHistoryFilter,
): boolean {
  switch (filter) {
    case "intent":
      return entry.kind === "intent";
    case "review":
      return entry.kind === "review";
    case "paper":
      return entry.kind === "paper_execution" || entry.decision === "approve_paper";
    case "denied":
      return entry.decision === "deny" || entry.status === "denied";
    case "all":
    default:
      return true;
  }
}

function intentHistoryEntry(
  intent: TradingFastOrderIntentWriteResult,
): TradingFastOrderAuditHistoryEntry {
  return {
    kind: "intent",
    generatedAt: intent.generatedAt,
    intentId: intent.intentId,
    status: intent.status,
    symbol: intent.ticket.symbol,
    side: intent.ticket.side,
    quantity: intent.ticket.quantity,
    paperOnly: true,
    sentBrokerOrder: false,
    brokerCommandEnabled: false,
    submissionCommand: "",
    sourcePath: FAST_ORDER_INTENTS_JSONL,
  };
}

function reviewHistoryEntry(
  review: TradingFastOrderIntentReviewResult,
): TradingFastOrderAuditHistoryEntry {
  return {
    kind: "review",
    generatedAt: review.generatedAt,
    intentId: review.intentId,
    status: review.status,
    decision: review.decision,
    symbol: review.ticket?.symbol ?? review.paperExecution?.symbol ?? "TX00",
    side: review.ticket?.side ?? review.paperExecution?.side ?? "wait",
    quantity: review.ticket?.quantity ?? review.paperExecution?.quantity ?? 1,
    paperOnly: true,
    sentBrokerOrder: false,
    brokerCommandEnabled: false,
    submissionCommand: "",
    sourcePath: FAST_ORDER_REVIEWS_JSONL,
  };
}

function paperExecutionHistoryEntry(raw: JsonRecord): TradingFastOrderAuditHistoryEntry {
  return {
    kind: "paper_execution",
    generatedAt: stringAt(raw, ["generatedAt"]),
    intentId: stringAt(raw, ["intentId"], "unknown"),
    status: stringAt(raw, ["status"], "paper_execution_recorded"),
    decision: "approve_paper",
    symbol: stringAt(raw, ["symbol"], "TX00"),
    side: stringAt(raw, ["side"], "wait"),
    quantity: numberAt(raw, ["quantity"], 1),
    paperOnly: true,
    sentBrokerOrder: false,
    brokerCommandEnabled: false,
    submissionCommand: "",
    sourcePath: FAST_ORDER_PAPER_EXECUTIONS_JSONL,
  };
}

async function readTradingFastOrderAuditHistory(
  repoRoot: string,
  query: Required<TradingFastOrderAuditHistoryQuery>,
): Promise<TradingFastOrderAuditSnapshot["history"]> {
  const [intentLines, reviewLines, paperExecutionLines] = await Promise.all([
    readLatestJsonLines(repoRoot, FAST_ORDER_INTENTS_JSONL),
    readLatestJsonLines(repoRoot, FAST_ORDER_REVIEWS_JSONL),
    readLatestJsonLines(repoRoot, FAST_ORDER_PAPER_EXECUTIONS_JSONL),
  ]);
  const entries = [
    ...intentLines
      .map(normalizeTradingFastOrderIntent)
      .filter((item): item is TradingFastOrderIntentWriteResult => Boolean(item))
      .map(intentHistoryEntry),
    ...reviewLines
      .map(normalizeTradingFastOrderReview)
      .filter((item): item is TradingFastOrderIntentReviewResult => Boolean(item))
      .map(reviewHistoryEntry),
    ...paperExecutionLines.map(paperExecutionHistoryEntry),
  ]
    .filter((entry) => matchesFastOrderAuditFilter(entry, query.filter))
    .toSorted(compareHistoryEntryDesc);
  const page = entries.slice(query.offset, query.offset + query.limit);
  return {
    filter: query.filter,
    offset: query.offset,
    limit: query.limit,
    total: entries.length,
    returned: page.length,
    hasPrevious: query.offset > 0,
    hasNext: query.offset + query.limit < entries.length,
    filters: FAST_ORDER_AUDIT_FILTERS,
    entries: page,
  };
}

export async function readTradingFastOrderAuditSnapshot(
  repoRoot = process.cwd(),
  queryParams: TradingFastOrderAuditHistoryQuery = {},
): Promise<TradingFastOrderAuditSnapshot> {
  const query = normalizeFastOrderAuditQuery(queryParams);
  const [latestIntent, latestReview, latestPaperExecution, fastOrderPaperPattern, history] =
    await Promise.all([
      readLatestTradingFastOrderIntent(repoRoot),
      readLatestTradingFastOrderReview(repoRoot),
      readJsonReport(repoRoot, FAST_ORDER_LATEST_PAPER_EXECUTION),
      readAssistantFastOrderPaperPattern(repoRoot),
      readTradingFastOrderAuditHistory(repoRoot, query),
    ]);
  const hasAny = Boolean(latestIntent || latestReview || latestPaperExecution || history.total > 0);
  return {
    schema: "openclaw.trading.fast-order-audit-snapshot.v1",
    generatedAt: new Date().toISOString(),
    status: hasAny ? "loaded" : "empty",
    latestIntent,
    latestReview,
    latestPaperExecution,
    fastOrderPaperPattern,
    safety: {
      sentBrokerOrder: false,
      brokerCommandEnabled: false,
      submissionCommand: "",
    },
    readTargets: {
      latestIntent: FAST_ORDER_LATEST_INTENT,
      latestReview: FAST_ORDER_LATEST_REVIEW,
      latestPaperExecution: FAST_ORDER_LATEST_PAPER_EXECUTION,
      intentsJsonl: FAST_ORDER_INTENTS_JSONL,
      reviewsJsonl: FAST_ORDER_REVIEWS_JSONL,
      paperExecutionsJsonl: FAST_ORDER_PAPER_EXECUTIONS_JSONL,
    },
    history,
    nextSafeTask: hasAny
      ? "用 Telegram filter/page 檢查最近審核與 paper execution；所有 live gate 通過前不得送 broker order。"
      : "先在 AI 交易平台寫入快速進出場審核票，再查詢審核紀錄。",
  };
}

export async function reviewTradingFastOrderIntent(
  decision: "approve_paper" | "deny",
  repoRoot = process.cwd(),
): Promise<TradingFastOrderIntentReviewResult> {
  const generatedAt = new Date().toISOString();
  const reviewJsonl = FAST_ORDER_REVIEWS_JSONL;
  const latestReview = FAST_ORDER_LATEST_REVIEW;
  const paperExecutionJsonl = FAST_ORDER_PAPER_EXECUTIONS_JSONL;
  const latestPaperExecution = FAST_ORDER_LATEST_PAPER_EXECUTION;
  const intent = await readLatestTradingFastOrderIntent(repoRoot);
  const missingResult: TradingFastOrderIntentReviewResult = {
    schema: "openclaw.trading.fast-order-review.v1",
    generatedAt,
    status: "missing_intent",
    decision,
    intentId: "missing",
    source: "telegram.fast-order-review",
    mode: "paper_only",
    audit: {
      sentBrokerOrder: false,
      brokerCommandEnabled: false,
      submissionCommand: "",
      blockers: ["fast-order-intent-missing", "broker-command-disabled"],
      reason: "沒有可審核的 Telegram fast-order intent；請先寫入審核票。",
    },
    writeTargets: {
      reviewJsonl,
      latestReview,
    },
    nextSafeTask: "先按 Telegram AI 交易平台的「寫入審核票」，再進行 approve/deny。",
  };

  const ticket = intent?.ticket;
  const result: TradingFastOrderIntentReviewResult = ticket
    ? {
        schema: "openclaw.trading.fast-order-review.v1",
        generatedAt,
        status: decision === "approve_paper" ? "paper_execution_recorded" : "denied",
        decision,
        intentId: intent.intentId,
        source: "telegram.fast-order-review",
        mode: "paper_only",
        ticket: {
          ...ticket,
          executionAllowed: false,
          liveOrderAllowed: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
        },
        ...(decision === "approve_paper"
          ? {
              paperExecution: {
                generatedAt,
                intentId: intent.intentId,
                status: "paper_execution_recorded",
                recorded: true,
                paperOnly: true,
                symbol: ticket.symbol,
                side: ticket.side,
                quantity: ticket.quantity,
                entry: ticket.entry,
                exit: ticket.exit,
                brokerApi: ticket.brokerApi,
                sentBrokerOrder: false,
                brokerCommandEnabled: false,
                submissionCommand: "",
              },
            }
          : {}),
        audit: {
          sentBrokerOrder: false,
          brokerCommandEnabled: false,
          submissionCommand: "",
          blockers: uniqueStrings([...intent.blockers, "broker-command-disabled"]),
          reason:
            decision === "approve_paper"
              ? "Telegram approve 只登錄 paper execution audit；broker write path remains locked."
              : "Telegram deny recorded; no paper execution and no broker order.",
        },
        writeTargets: {
          reviewJsonl,
          latestReview,
          ...(decision === "approve_paper"
            ? {
                paperExecutionJsonl,
                latestPaperExecution,
              }
            : {}),
        },
        nextSafeTask:
          decision === "approve_paper"
            ? "檢查 paper execution audit；fresh quote、promotion gate 與 explicit live approval 全部通過前不得送 broker order。"
            : "保留 deny audit；需要交易時重新寫入新的審核票。",
      }
    : missingResult;

  await fs.mkdir(path.dirname(path.join(repoRoot, reviewJsonl)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(repoRoot, latestReview)), { recursive: true });
  await fs.appendFile(path.join(repoRoot, reviewJsonl), `${JSON.stringify(result)}\n`, "utf8");
  await fs.writeFile(
    path.join(repoRoot, latestReview),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  if (decision === "approve_paper" && result.paperExecution) {
    await fs.mkdir(path.dirname(path.join(repoRoot, paperExecutionJsonl)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(repoRoot, latestPaperExecution)), { recursive: true });
    await fs.appendFile(
      path.join(repoRoot, paperExecutionJsonl),
      `${JSON.stringify(result.paperExecution)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, latestPaperExecution),
      `${JSON.stringify(result.paperExecution, null, 2)}\n`,
      "utf8",
    );
  }
  return result;
}

type NodeScriptRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage: string;
};

async function runNodeScript(
  repoRoot: string,
  scriptRelativePath: string,
  args: string[],
): Promise<NodeScriptRunResult> {
  const scriptPath = path.join(repoRoot, scriptRelativePath);
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            stdout,
            stderr,
            errorMessage:
              error instanceof Error ? error.message : scalarText(error, "unknown_error"),
          });
          return;
        }
        resolve({ ok: true, stdout, stderr, errorMessage: "" });
      },
    );
  });
}

async function syncLearningRefreshToWatchState(
  repoRoot: string,
  refresh: TradingFastOrderLearningSnapshotRefreshResult,
): Promise<NonNullable<TradingFastOrderLearningSnapshotRefreshResult["watchStateSync"]>> {
  const watchStatePath = path.join(repoRoot, AUTO_TRADING_WATCH_STATE_REPORT);
  try {
    const watchState = await readJsonReport(repoRoot, AUTO_TRADING_WATCH_STATE_REPORT);
    if (!watchState) {
      return {
        status: "missing_watch_state",
        watchStatePath,
      };
    }
    if (stringAt(watchState, ["schema"]) !== "openclaw.capital.auto-trading-watch-state.v1") {
      return {
        status: "invalid_watch_state",
        watchStatePath,
        error: `unexpected schema: ${stringAt(watchState, ["schema"], "missing")}`,
      };
    }
    await writeJsonWithSha(watchStatePath, {
      ...watchState,
      telegramPaperLoopLearningRefresh: {
        schema: refresh.schema,
        generatedAt: refresh.generatedAt,
        status: refresh.status,
        assistantFastOrderPaperPattern: refresh.assistantFastOrderPaperPattern,
        fastOrderPaperPattern: refresh.fastOrderPaperPattern,
        brokerCommandEnabled: false,
        sentBrokerOrder: false,
        submissionCommand: "",
        snapshotPath: refresh.snapshotPath,
        summaryPath: refresh.summaryPath,
        nextSafeTask: refresh.nextSafeTask,
        ...(refresh.error ? { error: refresh.error } : {}),
      },
    });
    return {
      status: "synced",
      watchStatePath,
    };
  } catch (error) {
    return {
      status: "sync_failed",
      watchStatePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function withWatchStateSync(
  repoRoot: string,
  refresh: TradingFastOrderLearningSnapshotRefreshResult,
): Promise<TradingFastOrderLearningSnapshotRefreshResult> {
  return {
    ...refresh,
    watchStateSync: await syncLearningRefreshToWatchState(repoRoot, refresh),
  };
}

function defaultLearningSnapshotRefreshResult(input: {
  repoRoot: string;
  generatedAt: string;
  fastOrderPaperPattern: TradingFastOrderPaperPatternSnapshot;
  status: "refreshed" | "refresh_failed";
  nextSafeTask: string;
  error?: string;
  assistantFastOrderPaperPattern?: string;
}): TradingFastOrderLearningSnapshotRefreshResult {
  const fallbackPattern = input.fastOrderPaperPattern;
  return {
    schema: "openclaw.trading.fast-order-learning-refresh.v1",
    generatedAt: input.generatedAt,
    status: input.status,
    snapshotPath: path.join(input.repoRoot, AUTO_TRADING_LEARNING_SNAPSHOT_REPORT),
    summaryPath: path.join(input.repoRoot, AUTO_TRADING_LEARNING_SUMMARY_REPORT),
    assistantFastOrderPaperPattern:
      input.assistantFastOrderPaperPattern || fallbackPattern.pattern || "no-paper-execution",
    fastOrderPaperPattern: fallbackPattern,
    brokerCommandEnabled: false,
    sentBrokerOrder: false,
    submissionCommand: "",
    nextSafeTask: input.nextSafeTask,
    readTargets: {
      script: AUTO_TRADING_LEARNING_SNAPSHOT_SCRIPT,
      snapshot: AUTO_TRADING_LEARNING_SNAPSHOT_REPORT,
      summary: AUTO_TRADING_LEARNING_SUMMARY_REPORT,
    },
    ...(input.error ? { error: input.error } : {}),
  };
}

export async function refreshTradingFastOrderLearningSnapshot(
  repoRoot = process.cwd(),
): Promise<TradingFastOrderLearningSnapshotRefreshResult> {
  const generatedAt = new Date().toISOString();
  const fallbackPattern = await readAssistantFastOrderPaperPattern(repoRoot);
  const execution = await runNodeScript(repoRoot, AUTO_TRADING_LEARNING_SNAPSHOT_SCRIPT, [
    "--repo-root",
    repoRoot,
    "--json",
  ]);
  if (!execution.ok) {
    return await withWatchStateSync(
      repoRoot,
      defaultLearningSnapshotRefreshResult({
        repoRoot,
        generatedAt,
        fastOrderPaperPattern: fallbackPattern,
        status: "refresh_failed",
        nextSafeTask:
          "paper loop 已完成，但 learning snapshot 刷新失敗；請執行 pnpm capital-hft:auto-trading-learning-snapshot。",
        error: execution.errorMessage || execution.stderr.trim() || "unknown_refresh_error",
      }),
    );
  }

  try {
    const report = asRecord(JSON.parse(execution.stdout.replace(/^\uFEFF/u, "")));
    const pattern = normalizeFastOrderPaperPattern(valueAt(report, ["fastOrderPaperPattern"]));
    return await withWatchStateSync(
      repoRoot,
      defaultLearningSnapshotRefreshResult({
        repoRoot,
        generatedAt,
        fastOrderPaperPattern: pattern,
        assistantFastOrderPaperPattern: scalarText(
          valueAt(report, ["assistant", "fastOrderPaperPattern"]),
          pattern.pattern,
        ),
        status: "refreshed",
        nextSafeTask: scalarText(
          valueAt(report, ["recommendation", "nextSafeTask"]),
          "learning snapshot 已刷新；下一輪可直接讀取 fast-order paper pattern。",
        ),
      }),
    );
  } catch (error) {
    return await withWatchStateSync(
      repoRoot,
      defaultLearningSnapshotRefreshResult({
        repoRoot,
        generatedAt,
        fastOrderPaperPattern: fallbackPattern,
        status: "refresh_failed",
        nextSafeTask:
          "paper loop 已完成，但 learning snapshot JSON 解析失敗；請執行 pnpm capital-hft:auto-trading-learning-snapshot。",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export const tradingHandlers: GatewayRequestHandlers = {
  "trading.snapshot": async ({ context, respond }) => {
    const payload = await buildTradingSnapshot(context.getRuntimeSnapshot());
    respond(true, payload, undefined);
  },
  "trading.fastOrderIntent.write": async ({ context, respond }) => {
    const snapshot = await buildTradingSnapshot(context.getRuntimeSnapshot());
    const payload = await writeTradingFastOrderIntent(snapshot);
    respond(true, payload, undefined);
  },
  "trading.fastOrderIntent.approvePaper": async ({ respond }) => {
    const payload = await reviewTradingFastOrderIntent("approve_paper");
    respond(true, payload, undefined);
  },
  "trading.fastOrderIntent.deny": async ({ respond }) => {
    const payload = await reviewTradingFastOrderIntent("deny");
    respond(true, payload, undefined);
  },
  "trading.fastOrderLearningSnapshot.refresh": async ({ respond }) => {
    const payload = await refreshTradingFastOrderLearningSnapshot();
    respond(true, payload, undefined);
  },
  "trading.fastOrderAudit.snapshot": async ({ params, respond }) => {
    const payload = await readTradingFastOrderAuditSnapshot(
      process.cwd(),
      normalizeFastOrderAuditQuery(params),
    );
    respond(true, payload, undefined);
  },
};
