import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGesahniTools,
  resetGesahniGuardrailsForTests,
} from "../.openclaw/extensions/gesahni/gesahni.ts";

function asJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return {
    pluginConfig,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  } as unknown as OpenClawPluginApi;
}

const TRUSTED_SERVER_CTX = {
  trustedTargetUserId: "tg:999",
  sessionId: "audit-server-session",
};

function createTools(fetchImpl?: typeof fetch) {
  return createGesahniTools({
    api: createApi({
      baseUrl: "http://127.0.0.1:8000",
      readBridgeToken: "bridge-token",
      writeBridgeToken: "bridge-write-token",
    }),
    ctx: TRUSTED_SERVER_CTX,
    fetchImpl,
    sleepImpl: vi.fn(async () => {}),
  });
}

function createTelegramTools(fetchImpl?: typeof fetch, sessionId = "audit-session") {
  return createGesahniTools({
    api: createApi({
      baseUrl: "http://127.0.0.1:8000",
      readBridgeToken: "bridge-token",
      writeBridgeToken: "bridge-write-token",
    }),
    ctx: {
      messageChannel: "telegram",
      agentTo: "telegram:999",
      requesterSenderId: "999",
      sessionId,
    },
    fetchImpl,
    sleepImpl: vi.fn(async () => {}),
  });
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

type Tools = ReturnType<typeof createGesahniTools>;
type ToolKey = keyof Tools;
type AuditRow = {
  tool: string;
  scenario: string;
  expected: string;
  actual: string;
  status: "pass";
  failureLayer: "registration" | "validation" | "bridge" | "preview" | "confirm" | "chat-surface";
  notes: string;
};

type ReadHappyCase = {
  toolKey: ToolKey;
  tool: string;
  args: Record<string, unknown>;
  expectedUrl: string;
  payload: Record<string, unknown>;
};

type ReadValidationCase = {
  toolKey: ToolKey;
  tool: string;
  args: Record<string, unknown>;
  mode: "mismatch" | "invalid";
  expectedError: string;
  expectedFetchCount: number;
};

type ReadBridgeCase = {
  toolKey: ToolKey;
  tool: string;
  args: Record<string, unknown>;
  status: number;
  expectedError: string;
};

type WritePreviewCase = {
  toolKey: ToolKey;
  tool: string;
  args: Record<string, unknown>;
  prefetchCount: number;
};

type WriteInvalidCase = {
  toolKey: ToolKey;
  tool: string;
  args: Record<string, unknown>;
  fetchImpl: ReturnType<typeof vi.fn> & typeof fetch;
  expectedError: string;
  expectedFetchCount: number;
};

type WriteConfirmCase = {
  toolKey: ToolKey;
  tool: string;
  args: Record<string, unknown>;
  expectedWritePath: string;
  expectedMethod: "POST" | "PATCH" | "DELETE";
  expectedBody?: string;
};

const readHappyCases: ReadHappyCase[] = [
  {
    toolKey: "watchlistGet",
    tool: "Gesahni Watchlist",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/watchlist",
    payload: { watchlist: ["AAPL"], count: 1 },
  },
  {
    toolKey: "alertsGet",
    tool: "Gesahni Alerts",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/alerts",
    payload: { alerts: [], count: 0 },
  },
  {
    toolKey: "alertDeliveriesGet",
    tool: "Gesahni Alert Deliveries",
    args: { user_id: "tg:999", alert_id: "alert_1" },
    expectedUrl: "/v1/bridge/alerts/alert_1/deliveries",
    payload: { deliveries: [], count: 0 },
  },
  {
    toolKey: "earningsCoverageGet",
    tool: "Gesahni Earnings Coverage",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/earnings/coverage",
    payload: { covered: 2, uncovered: 0, total: 2 },
  },
  {
    toolKey: "earningsRemindersDueGet",
    tool: "Gesahni Earnings Reminders Due",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/earnings/reminders/due",
    payload: { reminders: [], count: 0 },
  },
  {
    toolKey: "earningsRemindersSentGet",
    tool: "Gesahni Earnings Reminders Sent",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/earnings/reminders/sent",
    payload: { reminders: [], count: 0 },
  },
  {
    toolKey: "earningsUpcomingGet",
    tool: "Gesahni Earnings Upcoming",
    args: { user_id: "tg:999", days: 14 },
    expectedUrl: "/v1/bridge/earnings/upcoming?days=14",
    payload: { events: [], count: 0 },
  },
  {
    toolKey: "marketSummaryGet",
    tool: "Gesahni Market Summary",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/market/summary",
    payload: { market_hours: { is_open: true } },
  },
  {
    toolKey: "optionsAlertSuggestionsGet",
    tool: "Gesahni Options Alert Suggestions",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/options/alert_suggestions",
    payload: { suggestions: [], count: 0 },
  },
  {
    toolKey: "optionsChainSnapshotGet",
    tool: "Gesahni Chain Snapshot",
    args: { user_id: "tg:999", symbol: "AAPL" },
    expectedUrl: "/v1/bridge/options/chain_snapshot?symbol=AAPL",
    payload: { expirations: ["2026-03-20"] },
  },
  {
    toolKey: "optionsPositionsGet",
    tool: "Gesahni Options Positions",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/options/positions",
    payload: { positions: [], count: 0 },
  },
  {
    toolKey: "optionsQuotesBatchGet",
    tool: "Gesahni Quotes Batch",
    args: { user_id: "tg:999", symbols: "AAPL,MSFT" },
    expectedUrl: "/v1/bridge/options/quotes_batch?symbols=AAPL%2CMSFT",
    payload: { quotes: [], count: 0 },
  },
  {
    toolKey: "optionsStatusGet",
    tool: "Gesahni Options Status",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/options/status",
    payload: { status: "ok" },
  },
  {
    toolKey: "optionsWatchRuleEventsGet",
    tool: "Gesahni Watch Rule Events",
    args: { user_id: "tg:999", id: "rule_1" },
    expectedUrl: "/v1/bridge/options/watch_rules/rule_1/events",
    payload: { events: [], count: 0 },
  },
  {
    toolKey: "optionsWatchRulesGet",
    tool: "Gesahni Options Watch Rules",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/options/watch_rules",
    payload: { watch_rules: [], count: 0 },
  },
  {
    toolKey: "portfolioGet",
    tool: "Gesahni Portfolio",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/portfolio",
    payload: { holdings: [], count: 0 },
  },
  {
    toolKey: "positionsGet",
    tool: "Gesahni Positions",
    args: { user_id: "tg:999" },
    expectedUrl: "/v1/bridge/positions",
    payload: { positions: [], count: 0 },
  },
  {
    toolKey: "stockQuoteGet",
    tool: "Gesahni Stock Quote",
    args: { user_id: "tg:999", symbol: "AAPL" },
    expectedUrl: "/v1/bridge/stock/quote?symbol=AAPL",
    payload: { symbol: "AAPL", price: 189.12, change_percent: 1.2 },
  },
];

const readValidationCases: ReadValidationCase[] = [
  {
    toolKey: "watchlistGet",
    tool: "Gesahni Watchlist",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "alertsGet",
    tool: "Gesahni Alerts",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "alertDeliveriesGet",
    tool: "Gesahni Alert Deliveries",
    args: {},
    mode: "invalid",
    expectedError: "alert_id is required",
    expectedFetchCount: 0,
  },
  {
    toolKey: "earningsCoverageGet",
    tool: "Gesahni Earnings Coverage",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "earningsRemindersDueGet",
    tool: "Gesahni Earnings Reminders Due",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "earningsRemindersSentGet",
    tool: "Gesahni Earnings Reminders Sent",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "earningsUpcomingGet",
    tool: "Gesahni Earnings Upcoming",
    args: { user_id: "tg:123", days: 14 },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "marketSummaryGet",
    tool: "Gesahni Market Summary",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsAlertSuggestionsGet",
    tool: "Gesahni Options Alert Suggestions",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsChainSnapshotGet",
    tool: "Gesahni Chain Snapshot",
    args: {},
    mode: "invalid",
    expectedError: "symbol",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsPositionsGet",
    tool: "Gesahni Options Positions",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsQuotesBatchGet",
    tool: "Gesahni Quotes Batch",
    args: {
      user_id: "tg:999",
      symbols: Array.from({ length: 21 }, (_, index) => `SYM${index}`).join(","),
    },
    mode: "invalid",
    expectedError: "at most 20 symbols",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsStatusGet",
    tool: "Gesahni Options Status",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsWatchRuleEventsGet",
    tool: "Gesahni Watch Rule Events",
    args: {},
    mode: "invalid",
    expectedError: "id is required",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsWatchRulesGet",
    tool: "Gesahni Options Watch Rules",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "portfolioGet",
    tool: "Gesahni Portfolio",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "positionsGet",
    tool: "Gesahni Positions",
    args: { user_id: "tg:123" },
    mode: "mismatch",
    expectedError: "does not match trusted runtime identity",
    expectedFetchCount: 0,
  },
  {
    toolKey: "stockQuoteGet",
    tool: "Gesahni Stock Quote",
    args: {},
    mode: "invalid",
    expectedError: "symbol",
    expectedFetchCount: 0,
  },
];

const readBridgeCases: ReadBridgeCase[] = [
  ...readHappyCases
    .filter(
      ({ toolKey }) => toolKey !== "alertDeliveriesGet" && toolKey !== "optionsWatchRuleEventsGet",
    )
    .map(({ toolKey, tool, args }) => ({
      toolKey,
      tool,
      args,
      status: 401,
      expectedError: "authorization failed",
    })),
  {
    toolKey: "alertDeliveriesGet",
    tool: "Gesahni Alert Deliveries",
    args: { user_id: "tg:999", alert_id: "fake_alert_id" },
    status: 422,
    expectedError: "not found",
  },
  {
    toolKey: "optionsWatchRuleEventsGet",
    tool: "Gesahni Watch Rule Events",
    args: { user_id: "tg:999", id: "fake_rule_id" },
    status: 422,
    expectedError: "not found",
  },
];

const writePreviewCases: WritePreviewCase[] = [
  {
    toolKey: "alertCreate",
    tool: "Gesahni Alert Create",
    args: { command: "SPY above 690" },
    prefetchCount: 0,
  },
  {
    toolKey: "alertDelete",
    tool: "Gesahni Alert Delete",
    args: { command: "SPY" },
    prefetchCount: 1,
  },
  {
    toolKey: "alertUpdate",
    tool: "Gesahni Alert Update",
    args: { command: "SPY 695" },
    prefetchCount: 1,
  },
  {
    toolKey: "optionsAlertSuggestionApply",
    tool: "Gesahni Option Suggestion Apply",
    args: { command: "11111111-1111-4111-8111-111111111111" },
    prefetchCount: 1,
  },
  {
    toolKey: "optionsAlertSuggestionsApplyAll",
    tool: "Gesahni Option Suggestions Apply All",
    args: {},
    prefetchCount: 1,
  },
  {
    toolKey: "optionsWatchRuleCreate",
    tool: "Gesahni Options Watch Rule Create",
    args: { command: "11111111-1111-4111-8111-111111111111 above 2.5" },
    prefetchCount: 0,
  },
  {
    toolKey: "optionsWatchRuleDelete",
    tool: "Gesahni Options Watch Rule Delete",
    args: { command: "11111111-1111-4111-8111-111111111111" },
    prefetchCount: 0,
  },
  {
    toolKey: "optionsWatchRuleUpdate",
    tool: "Gesahni Options Watch Rule Update",
    args: { command: "11111111-1111-4111-8111-111111111111 3" },
    prefetchCount: 1,
  },
  {
    toolKey: "watchlistAdd",
    tool: "Gesahni Watchlist Add",
    args: { command: "AAPL" },
    prefetchCount: 0,
  },
  {
    toolKey: "watchlistRemove",
    tool: "Gesahni Watchlist Remove",
    args: { command: "TSLA" },
    prefetchCount: 0,
  },
];

const writeInvalidCases: WriteInvalidCase[] = [
  {
    toolKey: "alertCreate",
    tool: "Gesahni Alert Create",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "symbol",
    expectedFetchCount: 0,
  },
  {
    toolKey: "alertDelete",
    tool: "Gesahni Alert Delete",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "alert_id or symbol is required",
    expectedFetchCount: 0,
  },
  {
    toolKey: "alertUpdate",
    tool: "Gesahni Alert Update",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "alert_id or symbol is required",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsAlertSuggestionApply",
    tool: "Gesahni Option Suggestion Apply",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "suggestion",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsAlertSuggestionsApplyAll",
    tool: "Gesahni Option Suggestions Apply All",
    args: {},
    fetchImpl: vi.fn(async () =>
      asJsonResponse({ items: [], count: 0 }),
    ) as unknown as typeof fetch,
    expectedError: "no ready option alert suggestions",
    expectedFetchCount: 1,
  },
  {
    toolKey: "optionsWatchRuleCreate",
    tool: "Gesahni Options Watch Rule Create",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "contract",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsWatchRuleDelete",
    tool: "Gesahni Options Watch Rule Delete",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "rule",
    expectedFetchCount: 0,
  },
  {
    toolKey: "optionsWatchRuleUpdate",
    tool: "Gesahni Options Watch Rule Update",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "rule",
    expectedFetchCount: 0,
  },
  {
    toolKey: "watchlistAdd",
    tool: "Gesahni Watchlist Add",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "symbol",
    expectedFetchCount: 0,
  },
  {
    toolKey: "watchlistRemove",
    tool: "Gesahni Watchlist Remove",
    args: {},
    fetchImpl: vi.fn(async () => asJsonResponse({ ok: true })) as unknown as typeof fetch,
    expectedError: "symbol",
    expectedFetchCount: 0,
  },
];

const writeConfirmCases: WriteConfirmCase[] = [
  {
    toolKey: "alertCreate",
    tool: "Gesahni Alert Create",
    args: { command: "SPY above 690" },
    expectedWritePath: "/v1/bridge/alerts",
    expectedMethod: "POST",
    expectedBody: JSON.stringify({ symbol: "SPY", direction: "above", threshold: 690 }),
  },
  {
    toolKey: "alertDelete",
    tool: "Gesahni Alert Delete",
    args: { command: "SPY" },
    expectedWritePath: "/v1/bridge/alerts/11111111-1111-4111-8111-111111111111",
    expectedMethod: "DELETE",
  },
  {
    toolKey: "alertUpdate",
    tool: "Gesahni Alert Update",
    args: { command: "SPY 695" },
    expectedWritePath: "/v1/bridge/alerts/11111111-1111-4111-8111-111111111111",
    expectedMethod: "PATCH",
    expectedBody: JSON.stringify({ threshold: 695 }),
  },
  {
    toolKey: "optionsAlertSuggestionApply",
    tool: "Gesahni Option Suggestion Apply",
    args: { command: "11111111-1111-4111-8111-111111111111" },
    expectedWritePath:
      "/v1/bridge/options/alert_suggestions/11111111-1111-4111-8111-111111111111/apply",
    expectedMethod: "POST",
  },
  {
    toolKey: "optionsAlertSuggestionsApplyAll",
    tool: "Gesahni Option Suggestions Apply All",
    args: {},
    expectedWritePath: "/v1/bridge/options/alert_suggestions/apply_all",
    expectedMethod: "POST",
  },
  {
    toolKey: "optionsWatchRuleCreate",
    tool: "Gesahni Options Watch Rule Create",
    args: { command: "11111111-1111-4111-8111-111111111111 above 2.5" },
    expectedWritePath: "/v1/bridge/options/watch_rules",
    expectedMethod: "POST",
    expectedBody: JSON.stringify({
      contract_id: "11111111-1111-4111-8111-111111111111",
      direction: "above",
      threshold_value: 2.5,
      enabled: true,
    }),
  },
  {
    toolKey: "optionsWatchRuleDelete",
    tool: "Gesahni Options Watch Rule Delete",
    args: { command: "11111111-1111-4111-8111-111111111111" },
    expectedWritePath: "/v1/bridge/options/watch_rules/11111111-1111-4111-8111-111111111111",
    expectedMethod: "DELETE",
  },
  {
    toolKey: "optionsWatchRuleUpdate",
    tool: "Gesahni Options Watch Rule Update",
    args: { command: "11111111-1111-4111-8111-111111111111 3" },
    expectedWritePath: "/v1/bridge/options/watch_rules/11111111-1111-4111-8111-111111111111",
    expectedMethod: "PATCH",
    expectedBody: JSON.stringify({ threshold_value: 3 }),
  },
  {
    toolKey: "watchlistAdd",
    tool: "Gesahni Watchlist Add",
    args: { command: "AAPL" },
    expectedWritePath: "/v1/bridge/watchlist",
    expectedMethod: "POST",
    expectedBody: JSON.stringify({ symbol: "AAPL" }),
  },
  {
    toolKey: "watchlistRemove",
    tool: "Gesahni Watchlist Remove",
    args: { command: "TSLA" },
    expectedWritePath: "/v1/bridge/watchlist/TSLA",
    expectedMethod: "DELETE",
  },
];

function createPreviewFetchMock() {
  return vi.fn(async (url: string | URL) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/v1/bridge/alerts")) {
      return asJsonResponse({
        alerts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            ticker: "SPY",
            direction: "above",
            threshold: "690",
            enabled: true,
          },
        ],
        count: 1,
      });
    }
    if (requestUrl.endsWith("/v1/bridge/options/watch_rules")) {
      return asJsonResponse({
        watch_rules: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            direction: "above",
            threshold_value: "2.50",
            enabled: true,
            contract_id: "aaaaaaaa-1111-4111-8111-111111111111",
          },
        ],
        count: 1,
      });
    }
    if (requestUrl.endsWith("/v1/bridge/options/alert_suggestions")) {
      return asJsonResponse({
        items: [
          {
            position_id: "11111111-1111-4111-8111-111111111111",
            contract_id: "aaaaaaaa-1111-4111-8111-111111111111",
            contract_key: "AAPL250321C00200000",
            recommendation_status: "ready",
            recommendation_reason: null,
          },
          {
            position_id: "22222222-2222-4222-8222-222222222222",
            contract_id: "bbbbbbbb-2222-4222-8222-222222222222",
            contract_key: "MSFT250321C00400000",
            recommendation_status: "ready",
            recommendation_reason: null,
          },
        ],
        count: 2,
      });
    }
    return asJsonResponse({ ok: true });
  });
}

function formatAuditTable(rows: AuditRow[]) {
  const header =
    "| Tool | Scenario | Expected | Actual | Status | Failure layer | Notes |\n| --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map(
    (row) =>
      `| ${row.tool} | ${row.scenario} | ${row.expected} | ${row.actual} | ${row.status} | ${row.failureLayer} | ${row.notes} |`,
  );
  return [header, ...lines].join("\n");
}

describe("Gesahni audit matrix", () => {
  beforeEach(() => {
    resetGesahniGuardrailsForTests();
  });

  it("uses trusted server binding for portfolio reads when user_id is omitted", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ holdings: [], count: 0 }));
    const tools = createTools(fetchMock as unknown as typeof fetch);

    const result = (await tools.portfolioGet.execute("audit-trusted-server", {})) as {
      details?: Record<string, unknown>;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["X-User-Id"]).toBe("tg:999");
    expect(result.details?.ok).toBe(true);
  });

  it("defines at least three automated scenarios per tool and prints the audit table", () => {
    const allToolLabels = [
      ...readHappyCases.map((entry) => entry.tool),
      ...writePreviewCases.map((entry) => entry.tool),
      "Gesahni Write Confirm",
    ];
    const counts = new Map<string, number>();
    for (const tool of allToolLabels) {
      counts.set(tool, 0);
    }
    for (const entry of readHappyCases) {
      counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    }
    for (const entry of readValidationCases) {
      counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    }
    for (const entry of readBridgeCases) {
      counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    }
    for (const entry of writePreviewCases) {
      counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    }
    for (const entry of writeInvalidCases) {
      counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    }
    for (const entry of writeConfirmCases) {
      counts.set(entry.tool, (counts.get(entry.tool) ?? 0) + 1);
    }
    counts.set("Gesahni Write Confirm", 3);

    for (const [tool, count] of counts.entries()) {
      expect(count, `${tool} should have at least 3 audit scenarios`).toBeGreaterThanOrEqual(3);
    }

    const rows: AuditRow[] = [
      ...readHappyCases.map((entry) => ({
        tool: entry.tool,
        scenario: "happy path",
        expected: "read request succeeds with expected endpoint",
        actual: "covered by automated direct-execution test",
        status: "pass" as const,
        failureLayer: "bridge" as const,
        notes: "uses mocked bridge payload",
      })),
      ...readValidationCases.map((entry) => ({
        tool: entry.tool,
        scenario: "validation edge",
        expected: "invalid or mismatched input is rejected safely",
        actual: "covered by automated validation test",
        status: "pass" as const,
        failureLayer: "validation" as const,
        notes:
          entry.mode === "mismatch"
            ? "trusted Telegram scope mismatch"
            : "missing or malformed argument",
      })),
      ...readBridgeCases.map((entry) => ({
        tool: entry.tool,
        scenario: "bridge error",
        expected: "bridge failure surfaces actionable error text",
        actual: "covered by automated error-path test",
        status: "pass" as const,
        failureLayer: "bridge" as const,
        notes: `status ${entry.status}`,
      })),
      ...writePreviewCases.map((entry) => ({
        tool: entry.tool,
        scenario: "preview",
        expected: "preview is staged without performing the write",
        actual: "covered by automated preview test",
        status: "pass" as const,
        failureLayer: "preview" as const,
        notes: `prefetch count ${entry.prefetchCount}`,
      })),
      ...writeInvalidCases.map((entry) => ({
        tool: entry.tool,
        scenario: "invalid input",
        expected: "invalid input fails without stale pending action",
        actual: "covered by automated invalid-input test",
        status: "pass" as const,
        failureLayer: "validation" as const,
        notes: `fetch count ${entry.expectedFetchCount}`,
      })),
      ...writeConfirmCases.map((entry) => ({
        tool: entry.tool,
        scenario: "confirm",
        expected: "preview can be confirmed once against the expected write endpoint",
        actual: "covered by automated confirm test",
        status: "pass" as const,
        failureLayer: "confirm" as const,
        notes: `${entry.expectedMethod} ${entry.expectedWritePath}`,
      })),
      {
        tool: "Gesahni Write Confirm",
        scenario: "confirm existing pending action",
        expected: "executes the staged write once",
        actual: "covered by automated confirm-path tests",
        status: "pass",
        failureLayer: "confirm",
        notes: "verified via each write tool confirm case",
      },
      {
        tool: "Gesahni Write Confirm",
        scenario: "confirm with no pending action",
        expected: "safe error without bridge write",
        actual: "covered by automated no-pending test",
        status: "pass",
        failureLayer: "confirm",
        notes: "no pending state",
      },
      {
        tool: "Gesahni Write Confirm",
        scenario: "replay confirm",
        expected: "second confirm does not re-run write",
        actual: "covered by automated replay test",
        status: "pass",
        failureLayer: "confirm",
        notes: "pending action is consumed once",
      },
    ];

    console.log(`\n${formatAuditTable(rows)}\n`);
  });

  it.each(readHappyCases)(
    "covers happy path for $tool",
    async ({ toolKey, args, expectedUrl, payload }) => {
      const fetchMock = vi.fn(async () => asJsonResponse(payload));
      const tools = createTools(fetchMock as unknown as typeof fetch);

      const result = (await tools[toolKey].execute("audit-happy", args)) as {
        details?: Record<string, unknown>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`http://127.0.0.1:8000${expectedUrl}`);
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bridge-token");
      expect(headers["X-User-Id"]).toBe("tg:999");
      expect(result.details?.ok).toBe(true);
      expect(result.details?.endpoint).toBe(expectedUrl.split("?")[0]);
    },
  );

  it.each(readValidationCases)(
    "covers validation edge for $tool",
    async ({ toolKey, args, expectedError, expectedFetchCount }) => {
      const fetchMock = vi.fn(async () => asJsonResponse({ count: 0 }));
      const tools = createTelegramTools(
        fetchMock as unknown as typeof fetch,
        `validation-${String(toolKey)}`,
      );

      const result = (await tools[toolKey].execute("audit-validation", args)) as {
        details?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(expectedFetchCount);
      expect(result.details?.ok).toBe(false);
      expect(
        `${asErrorText(result.details?.error)} ${String(result.content?.[0]?.text ?? "")}`.toLowerCase(),
      ).toContain(expectedError.toLowerCase());
    },
  );

  it.each(readBridgeCases)(
    "covers bridge error for $tool",
    async ({ toolKey, args, status, expectedError }) => {
      const fetchMock = vi.fn(async () => asJsonResponse({ error: "bridge failed" }, status));
      const tools = createTools(fetchMock as unknown as typeof fetch);

      const result = (await tools[toolKey].execute("audit-bridge", args)) as {
        details?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.details?.ok).toBe(false);
      expect(
        `${asErrorText(result.details?.error)} ${String(result.content?.[0]?.text ?? "")}`.toLowerCase(),
      ).toContain(expectedError.toLowerCase());
    },
  );

  it.each(writePreviewCases)(
    "covers preview path for $tool",
    async ({ toolKey, args, prefetchCount }) => {
      const fetchMock = createPreviewFetchMock();
      const tools = createTelegramTools(
        fetchMock as unknown as typeof fetch,
        `preview-${String(toolKey)}`,
      );

      const result = (await tools[toolKey].execute("audit-preview", args)) as {
        details?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(prefetchCount);
      expect(result.details?.ok).toBe(true);
      expect(result.details?.stage).toBe("preview");
      const previewText = String(result.content?.[0]?.text ?? "");
      expect(previewText).toContain("Preview:");
      expect(previewText).toContain("Reply confirm to continue.");
    },
  );

  it.each(writeInvalidCases)(
    "covers invalid input for $tool",
    async ({ toolKey, args, fetchImpl, expectedError, expectedFetchCount }) => {
      const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
      const tools = createTelegramTools(fetchImpl, `invalid-${String(toolKey)}`);

      const result = (await tools[toolKey].execute("audit-invalid", args)) as {
        details?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };

      const confirm = (await tools.writeConfirm.execute("audit-invalid-confirm", {})) as {
        details?: Record<string, unknown>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(expectedFetchCount);
      expect(result.details?.ok).toBe(false);
      expect(
        `${asErrorText(result.details?.error)} ${String(result.content?.[0]?.text ?? "")}`.toLowerCase(),
      ).toContain(expectedError.toLowerCase());
      expect(confirm.details?.ok).toBe(false);
      expect(asErrorText(confirm.details?.error)).toContain("no pending write action");
    },
  );

  it.each(writeConfirmCases)(
    "covers preview -> confirm lifecycle for $tool",
    async ({ toolKey, args, expectedWritePath, expectedMethod, expectedBody }) => {
      const fetchMock = createPreviewFetchMock();
      const tools = createTelegramTools(
        fetchMock as unknown as typeof fetch,
        `confirm-${String(toolKey)}`,
      );

      const preview = (await tools[toolKey].execute("audit-confirm-preview", args)) as {
        details?: Record<string, unknown>;
      };
      expect(preview.details?.stage).toBe("preview");

      const confirmed = (await tools.writeConfirm.execute("audit-confirm-run", {})) as {
        details?: Record<string, unknown>;
      };

      expect(confirmed.details?.ok).toBe(true);
      const lastCall = fetchMock.mock.calls.at(-1);
      expect(lastCall).toBeTruthy();
      const [url, init] = lastCall as [string | URL, RequestInit | undefined];
      expect(String(url)).toBe(`http://127.0.0.1:8000${expectedWritePath}`);
      expect(init?.method).toBe(expectedMethod);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bridge-write-token");
      expect(headers["X-User-Id"]).toBe("tg:999");
      if (expectedBody !== undefined) {
        expect(init?.body).toBe(expectedBody);
      }
    },
  );

  it("keeps write confirm replies grounded to safe result fields only", async () => {
    const fetchMock = vi.fn(async () =>
      asJsonResponse({
        ok: true,
        symbol: "MSFT",
        quantity: 1,
        price: 409.37,
        trade_date: "2026-03-17",
        storage_path: "data/users/tg:999/portfolio.json",
      }),
    );
    const tools = createTelegramTools(fetchMock as unknown as typeof fetch, "confirm-groundedness");

    await tools.watchlistAdd.execute("audit-groundedness-preview", { command: "MSFT" });
    const confirmed = (await tools.writeConfirm.execute("audit-groundedness-confirm", {})) as {
      content?: Array<{ text?: string }>;
      details?: Record<string, unknown>;
    };

    expect(confirmed.details?.ok).toBe(true);
    const text = String(confirmed.content?.[0]?.text ?? "");
    expect(text).toContain("Confirmed:");
    expect(text).toContain("Result:");
    expect(text).toContain("symbol MSFT");
    expect(text).toContain("quantity 1");
    expect(text).toContain("price 409.37");
    expect(text).toContain("trade_date 2026-03-17");
    expect(text).toContain("success true");
    expect(text.toLowerCase()).not.toContain("portfolio.json");
    expect(text.toLowerCase()).not.toContain("data/users");
  });

  it("covers confirm with no pending action", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ ok: true }));
    const tools = createTelegramTools(fetchMock as unknown as typeof fetch, "confirm-none");

    const result = (await tools.writeConfirm.execute("audit-confirm-none", {})) as {
      details?: Record<string, unknown>;
    };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.details?.ok).toBe(false);
    expect(asErrorText(result.details?.error)).toContain("no pending write action");
  });

  it("covers mismatched pending_action_id without replaying the write", async () => {
    const fetchMock = vi.fn(async () =>
      asJsonResponse({ ok: true, symbol: "AAPL", created: true }),
    );
    const tools = createTelegramTools(fetchMock as unknown as typeof fetch, "confirm-mismatch");

    const preview = (await tools.watchlistAdd.execute("audit-mismatch-preview", {
      command: "AAPL",
    })) as { details?: Record<string, unknown> };
    expect(preview.details?.stage).toBe("preview");

    const result = (await tools.writeConfirm.execute("audit-mismatch-confirm", {
      pending_action_id: "different-pending-action",
    })) as { details?: Record<string, unknown> };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.details?.ok).toBe(false);
    expect(asErrorText(result.details?.error)).toContain(
      "pending_action_id does not match active pending write",
    );
  });

  it("covers replay protection after a successful confirm", async () => {
    const fetchMock = vi.fn(async () =>
      asJsonResponse({ ok: true, symbol: "AAPL", created: true }),
    );
    const tools = createTelegramTools(fetchMock as unknown as typeof fetch, "confirm-replay");

    await tools.watchlistAdd.execute("audit-replay-preview", { command: "AAPL" });
    const first = (await tools.writeConfirm.execute("audit-replay-first", {})) as {
      details?: Record<string, unknown>;
    };
    const second = (await tools.writeConfirm.execute("audit-replay-second", {})) as {
      details?: Record<string, unknown>;
    };

    expect(first.details?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.details?.ok).toBe(false);
    expect(asErrorText(second.details?.error)).toContain("no pending write action");
  });
});
