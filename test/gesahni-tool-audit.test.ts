import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGesahniTools,
  resetGesahniGuardrailsForTests,
} from "../.openclaw/extensions/gesahni/gesahni.js";
import gesahniPlugin from "../.openclaw/extensions/gesahni/index.js";

type ToolResult = {
  details?: Record<string, unknown>;
  content?: Array<{ text?: string }>;
};

type RegisteredTool = {
  name: string;
  create: (ctx?: unknown) => unknown;
};

type RouteExpectation = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  response: Response | (() => Response);
};

type AuditRow = {
  tool: string;
  scenario: string;
  expected: string;
  actual: string;
  status: "pass" | "fail" | "blocked";
  failureLayer: "registration" | "validation" | "bridge" | "preview" | "confirm" | "chat-surface";
  notes: string;
};

type ReadToolDef = {
  key: keyof ReturnType<typeof createGesahniTools>;
  label: string;
  registeredName: string;
  successArgs: Record<string, unknown>;
  successUrl: string;
  successPayload: Record<string, unknown>;
  successTextIncludes: string[];
  invalidArgs: Record<string, unknown>;
  invalidTextIncludes: string[];
  bridgeErrorArgs?: Record<string, unknown>;
  bridgeErrorUrl?: string;
  bridgeErrorStatus?: number;
  bridgeErrorPayload?: Record<string, unknown>;
  bridgeErrorTextIncludes: string[];
  chatPrompt: string;
};

type WriteToolDef = {
  key: keyof ReturnType<typeof createGesahniTools>;
  label: string;
  registeredName: string;
  previewArgs: Record<string, unknown>;
  invalidArgs: Record<string, unknown>;
  invalidTextIncludes: string[];
  previewRoutes?: RouteExpectation[];
  invalidRoutes?: RouteExpectation[];
  confirmRoutes: RouteExpectation[];
  confirmTextIncludes?: string[];
  chatPrompt: string;
};

const DEFAULT_API_CONFIG = {
  baseUrl: "http://127.0.0.1:8000",
  readBridgeToken: "bridge-token",
  writeBridgeToken: "bridge-write-token",
  defaultTimeoutMs: 2500,
};

const TRUSTED_TELEGRAM_CTX = {
  messageChannel: "telegram",
  agentTo: "telegram:999",
  requesterSenderId: "999",
  sessionId: "gesahni-audit-session",
};

const TRUSTED_SERVER_CTX = {
  trustedTargetUserId: "tg:999",
  sessionId: "gesahni-server-session",
};

const STOCK_ALERT_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const SUGGESTION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SUGGESTION_ID = "22222222-2222-4222-8222-222222222222";

const ALERTS_PAYLOAD = {
  alerts: [
    {
      id: STOCK_ALERT_ID,
      ticker: "SPY",
      direction: "above",
      threshold: "690",
      enabled: true,
    },
  ],
  count: 1,
};

const WATCH_RULES_PAYLOAD = {
  watch_rules: [
    {
      id: RULE_ID,
      direction: "above",
      threshold_value: "2.50",
      enabled: true,
      contract_id: CONTRACT_ID,
    },
  ],
  count: 1,
};

const READY_SUGGESTIONS_PAYLOAD = {
  items: [
    {
      position_id: SUGGESTION_ID,
      contract_id: CONTRACT_ID,
      contract_key: "AAPL250321C00200000",
      recommendation_status: "ready",
      recommendation_reason: null,
    },
    {
      position_id: SECOND_SUGGESTION_ID,
      contract_id: "bbbbbbbb-2222-4222-8222-222222222222",
      contract_key: "MSFT250321C00400000",
      recommendation_status: "ready",
      recommendation_reason: null,
    },
  ],
  count: 2,
};

function asJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return {
    pluginConfig: {
      ...DEFAULT_API_CONFIG,
      ...pluginConfig,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerCommand() {},
  } as unknown as OpenClawPluginApi;
}

function extractText(result: ToolResult): string {
  return String(result.content?.map((entry) => entry.text ?? "").join("\n") ?? "");
}

function asErrorText(result: ToolResult): string {
  const value = result.details?.error;
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value !== undefined) {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return extractText(result);
}

function createFetchMock(expectations: RouteExpectation[]): typeof fetch {
  let index = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    const expectation = expectations[index];
    if (!expectation) {
      throw new Error(`unexpected fetch call ${String(url)} at index ${String(index)}`);
    }
    index += 1;
    expect(String(url)).toBe(expectation.url);
    expect(init?.method ?? "GET").toBe(expectation.method ?? "GET");
    if (expectation.headers) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      for (const [key, value] of Object.entries(expectation.headers)) {
        expect(headers[key]).toBe(value);
      }
    }
    return typeof expectation.response === "function"
      ? expectation.response()
      : expectation.response.clone();
  }) as typeof fetch;
}

function renderMarkdownTable(rows: AuditRow[]): string {
  const header =
    "| Tool | Scenario | Expected | Actual | Status | Failure layer | Notes |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |";
  const body = rows
    .map((row) =>
      [row.tool, row.scenario, row.expected, row.actual, row.status, row.failureLayer, row.notes]
        .map((value) => String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>"))
        .join(" | "),
    )
    .map((line) => `| ${line} |`)
    .join("\n");
  return `${header}\n${body}`;
}

const READ_TOOLS: ReadToolDef[] = [
  {
    key: "watchlistGet",
    label: "Gesahni Watchlist",
    registeredName: "gesahni_watchlist_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/watchlist",
    successPayload: { watchlist: ["AAPL"], count: 1 },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my watchlist",
  },
  {
    key: "alertsGet",
    label: "Gesahni Alerts",
    registeredName: "gesahni_alerts_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/alerts",
    successPayload: ALERTS_PAYLOAD,
    successTextIncludes: ["SPY"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my alerts",
  },
  {
    key: "alertDeliveriesGet",
    label: "Gesahni Alert Deliveries",
    registeredName: "gesahni_alert_deliveries_get",
    successArgs: { user_id: "tg:999", alert_id: "alert_1" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/alerts/alert_1/deliveries",
    successPayload: {
      deliveries: [{ status: "sent", delivered_at: "2026-03-11T00:00:00Z" }],
      count: 1,
    },
    successTextIncludes: ["sent"],
    invalidArgs: { user_id: "tg:999" },
    invalidTextIncludes: ["alert_id is required"],
    bridgeErrorArgs: { user_id: "tg:999", alert_id: "fake_alert_id" },
    bridgeErrorUrl: "http://127.0.0.1:8000/v1/bridge/alerts/fake_alert_id/deliveries",
    bridgeErrorStatus: 422,
    bridgeErrorPayload: { error: "no record" },
    bridgeErrorTextIncludes: ["not found"],
    chatPrompt: "/alert_history alert_1",
  },
  {
    key: "earningsCoverageGet",
    label: "Gesahni Earnings Coverage",
    registeredName: "gesahni_earnings_coverage_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/earnings/coverage",
    successPayload: { covered: 2, uncovered: 0, total: 2 },
    successTextIncludes: ["2"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my earnings coverage",
  },
  {
    key: "earningsRemindersDueGet",
    label: "Gesahni Earnings Reminders Due",
    registeredName: "gesahni_earnings_reminders_due_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/earnings/reminders/due",
    successPayload: { reminders: [{ symbol: "AAPL" }], count: 1 },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show due earnings reminders",
  },
  {
    key: "earningsRemindersSentGet",
    label: "Gesahni Earnings Reminders Sent",
    registeredName: "gesahni_earnings_reminders_sent_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/earnings/reminders/sent",
    successPayload: { reminders: [{ symbol: "MSFT" }], count: 1 },
    successTextIncludes: ["MSFT"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show sent earnings reminders",
  },
  {
    key: "earningsUpcomingGet",
    label: "Gesahni Earnings Upcoming",
    registeredName: "gesahni_earnings_upcoming_get",
    successArgs: { user_id: "tg:999", days: 14 },
    successUrl: "http://127.0.0.1:8000/v1/bridge/earnings/upcoming?days=14",
    successPayload: { events: [{ symbol: "AAPL" }], count: 1 },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show upcoming earnings",
  },
  {
    key: "marketSummaryGet",
    label: "Gesahni Market Summary",
    registeredName: "gesahni_market_summary_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/market/summary",
    successPayload: { market_hours: { is_open: true }, summary: "risk-on" },
    successTextIncludes: ["open"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show market summary",
  },
  {
    key: "optionsAlertSuggestionsGet",
    label: "Gesahni Options Alert Suggestions",
    registeredName: "gesahni_options_alert_suggestions_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/alert_suggestions",
    successPayload: {
      items: [
        {
          position_id: SUGGESTION_ID,
          symbol: "AAPL",
          reason: "threshold",
          recommendation_status: "ready",
        },
      ],
      count: 1,
    },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show option alert suggestions",
  },
  {
    key: "optionsChainSnapshotGet",
    label: "Gesahni Chain Snapshot",
    registeredName: "gesahni_options_chain_snapshot_get",
    successArgs: { user_id: "tg:999", symbol: "AAPL" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/chain_snapshot?symbol=AAPL",
    successPayload: { expirations: ["2026-03-20"], chain: [] },
    successTextIncludes: ["AAPL"],
    invalidArgs: { user_id: "tg:999" },
    invalidTextIncludes: ["symbol is required"],
    bridgeErrorArgs: { user_id: "tg:999", symbol: "ZZZZ" },
    bridgeErrorUrl: "http://127.0.0.1:8000/v1/bridge/options/chain_snapshot?symbol=ZZZZ",
    bridgeErrorStatus: 401,
    bridgeErrorPayload: { error: "unauthorized" },
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show the options chain snapshot for AAPL",
  },
  {
    key: "optionsPositionsGet",
    label: "Gesahni Options Positions",
    registeredName: "gesahni_options_positions_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/positions",
    successPayload: { positions: [{ symbol: "AAPL" }], count: 1 },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my options positions",
  },
  {
    key: "optionsQuotesBatchGet",
    label: "Gesahni Quotes Batch",
    registeredName: "gesahni_options_quotes_batch_get",
    successArgs: { user_id: "tg:999", symbols: "AAPL,MSFT" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/quotes_batch?symbols=AAPL%2CMSFT",
    successPayload: { quotes: [{ symbol: "AAPL" }, { symbol: "MSFT" }], count: 2 },
    successTextIncludes: ["AAPL", "MSFT"],
    invalidArgs: {
      user_id: "tg:999",
      symbols: Array.from({ length: 21 }, (_, i) => `SYM${i}`).join(","),
    },
    invalidTextIncludes: ["at most 20 symbols"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "/quotes AAPL MSFT",
  },
  {
    key: "optionsStatusGet",
    label: "Gesahni Options Status",
    registeredName: "gesahni_options_status_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/status",
    successPayload: { status: "ok", broker: "alpaca" },
    successTextIncludes: ["ok"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my options status",
  },
  {
    key: "optionsWatchRuleEventsGet",
    label: "Gesahni Watch Rule Events",
    registeredName: "gesahni_options_watch_rule_events_get",
    successArgs: { user_id: "tg:999", id: "rule_1" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/watch_rules/rule_1/events",
    successPayload: { events: [{ state: "fired" }], count: 1 },
    successTextIncludes: ["Watch rule events"],
    invalidArgs: { user_id: "tg:999" },
    invalidTextIncludes: ["id is required"],
    bridgeErrorArgs: { user_id: "tg:999", id: "fake_rule_id" },
    bridgeErrorUrl: "http://127.0.0.1:8000/v1/bridge/options/watch_rules/fake_rule_id/events",
    bridgeErrorStatus: 500,
    bridgeErrorPayload: { error: "no record" },
    bridgeErrorTextIncludes: ["not found"],
    chatPrompt: "/option_alerts_events rule_1",
  },
  {
    key: "optionsWatchRulesGet",
    label: "Gesahni Options Watch Rules",
    registeredName: "gesahni_options_watch_rules_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/options/watch_rules",
    successPayload: {
      watch_rules: [{ id: RULE_ID, underlying: "AAPL", status: "armed" }],
      count: 1,
    },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my options watch rules",
  },
  {
    key: "portfolioGet",
    label: "Gesahni Portfolio",
    registeredName: "gesahni_portfolio_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/portfolio",
    successPayload: { holdings: [{ symbol: "AAPL" }], count: 1 },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my portfolio",
  },
  {
    key: "positionsGet",
    label: "Gesahni Positions",
    registeredName: "gesahni_positions_get",
    successArgs: { user_id: "tg:999" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/positions",
    successPayload: { positions: [{ symbol: "AAPL" }], count: 1 },
    successTextIncludes: ["AAPL"],
    invalidArgs: {},
    invalidTextIncludes: ["user_id is required"],
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "Show my positions",
  },
  {
    key: "stockQuoteGet",
    label: "Gesahni Stock Quote",
    registeredName: "gesahni_stock_quote_get",
    successArgs: { user_id: "tg:999", symbol: "AAPL" },
    successUrl: "http://127.0.0.1:8000/v1/bridge/stock/quote?symbol=AAPL",
    successPayload: {
      provider: "alpaca",
      quotes: [{ symbol: "AAPL", last: 201.15 }],
    },
    successTextIncludes: ["Quote AAPL", "$201.15"],
    invalidArgs: { user_id: "tg:999" },
    invalidTextIncludes: ["symbol is required"],
    bridgeErrorArgs: { user_id: "tg:999", symbol: "ZZZZ" },
    bridgeErrorUrl: "http://127.0.0.1:8000/v1/bridge/stock/quote?symbol=ZZZZ",
    bridgeErrorStatus: 401,
    bridgeErrorPayload: { error: "unauthorized" },
    bridgeErrorTextIncludes: ["authorization failed"],
    chatPrompt: "What's AAPL at?",
  },
];

const WRITE_TOOLS: WriteToolDef[] = [
  {
    key: "alertCreate",
    label: "Gesahni Alert Create",
    registeredName: "gesahni_alert_create",
    previewArgs: { command: "TSLA above 300" },
    invalidArgs: { symbol: "TSLA" },
    invalidTextIncludes: ["direction is required"],
    confirmRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/alerts",
        method: "POST",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, created: true }),
      },
    ],
    confirmTextIncludes: ["Confirmed:"],
    chatPrompt: "Alert me if TSLA goes above 300",
  },
  {
    key: "alertDelete",
    label: "Gesahni Alert Delete",
    registeredName: "gesahni_alert_delete",
    previewArgs: { command: "SPY" },
    invalidArgs: {},
    invalidTextIncludes: ["alert_id or symbol is required"],
    previewRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/alerts",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse(ALERTS_PAYLOAD),
      },
    ],
    confirmRoutes: [
      {
        url: `http://127.0.0.1:8000/v1/bridge/alerts/${STOCK_ALERT_ID}`,
        method: "DELETE",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, deleted: true }),
      },
    ],
    chatPrompt: "/alert_delete SPY",
  },
  {
    key: "alertUpdate",
    label: "Gesahni Alert Update",
    registeredName: "gesahni_alert_update",
    previewArgs: { command: "SPY 695" },
    invalidArgs: {},
    invalidTextIncludes: ["alert_id or symbol is required"],
    previewRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/alerts",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse(ALERTS_PAYLOAD),
      },
    ],
    confirmRoutes: [
      {
        url: `http://127.0.0.1:8000/v1/bridge/alerts/${STOCK_ALERT_ID}`,
        method: "PATCH",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, updated: true }),
      },
    ],
    chatPrompt: "/alert_update SPY 695",
  },
  {
    key: "optionsAlertSuggestionApply",
    label: "Gesahni Option Suggestion Apply",
    registeredName: "gesahni_options_alert_suggestion_apply",
    previewArgs: { command: SUGGESTION_ID },
    invalidArgs: { command: "not-a-uuid" },
    invalidTextIncludes: ["suggestion_id is required"],
    previewRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/alert_suggestions",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse(READY_SUGGESTIONS_PAYLOAD),
      },
    ],
    confirmRoutes: [
      {
        url: `http://127.0.0.1:8000/v1/bridge/options/alert_suggestions/${SUGGESTION_ID}/apply`,
        method: "POST",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, applied: true }),
      },
    ],
    chatPrompt: "/options_alert_suggestion_apply 11111111-1111-4111-8111-111111111111",
  },
  {
    key: "optionsAlertSuggestionsApplyAll",
    label: "Gesahni Option Suggestions Apply All",
    registeredName: "gesahni_options_alert_suggestions_apply_all",
    previewArgs: {},
    invalidArgs: {},
    invalidTextIncludes: ["no ready option alert suggestions"],
    invalidRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/alert_suggestions",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ items: [], count: 0 }),
      },
    ],
    previewRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/alert_suggestions",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse(READY_SUGGESTIONS_PAYLOAD),
      },
    ],
    confirmRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/alert_suggestions",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse(READY_SUGGESTIONS_PAYLOAD),
      },
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/alert_suggestions/apply_all",
        method: "POST",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, applied_count: 2 }),
      },
    ],
    chatPrompt: "Apply all option suggestions",
  },
  {
    key: "optionsWatchRuleCreate",
    label: "Gesahni Options Watch Rule Create",
    registeredName: "gesahni_options_watch_rule_create",
    previewArgs: { command: `${CONTRACT_ID} above 2.5` },
    invalidArgs: { command: "not-a-uuid above 2.5" },
    invalidTextIncludes: ["contract_id is required"],
    confirmRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/watch_rules",
        method: "POST",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, created: true }),
      },
    ],
    chatPrompt: "/options_watch_rule_create 11111111-1111-4111-8111-111111111111 above 2.5",
  },
  {
    key: "optionsWatchRuleDelete",
    label: "Gesahni Options Watch Rule Delete",
    registeredName: "gesahni_options_watch_rule_delete",
    previewArgs: { command: RULE_ID },
    invalidArgs: { command: "not-a-uuid" },
    invalidTextIncludes: ["rule_id is required"],
    confirmRoutes: [
      {
        url: `http://127.0.0.1:8000/v1/bridge/options/watch_rules/${RULE_ID}`,
        method: "DELETE",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, deleted: true }),
      },
    ],
    chatPrompt: "/options_watch_rule_delete 11111111-1111-4111-8111-111111111111",
  },
  {
    key: "optionsWatchRuleUpdate",
    label: "Gesahni Options Watch Rule Update",
    registeredName: "gesahni_options_watch_rule_update",
    previewArgs: { command: `${RULE_ID} 3` },
    invalidArgs: { command: "not-a-uuid 3" },
    invalidTextIncludes: ["rule_id is required"],
    previewRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/options/watch_rules",
        headers: {
          Authorization: "Bearer bridge-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse(WATCH_RULES_PAYLOAD),
      },
    ],
    confirmRoutes: [
      {
        url: `http://127.0.0.1:8000/v1/bridge/options/watch_rules/${RULE_ID}`,
        method: "PATCH",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, updated: true }),
      },
    ],
    chatPrompt: "/options_watch_rule_update 11111111-1111-4111-8111-111111111111 3",
  },
  {
    key: "watchlistAdd",
    label: "Gesahni Watchlist Add",
    registeredName: "gesahni_watchlist_add",
    previewArgs: { command: "AAPL" },
    invalidArgs: { command: "" },
    invalidTextIncludes: ["symbol is required"],
    confirmRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/watchlist",
        method: "POST",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, created: true }),
      },
    ],
    chatPrompt: "Add AAPL to my watchlist",
  },
  {
    key: "watchlistRemove",
    label: "Gesahni Watchlist Remove",
    registeredName: "gesahni_watchlist_remove",
    previewArgs: { command: "AAPL" },
    invalidArgs: { command: "" },
    invalidTextIncludes: ["symbol is required"],
    confirmRoutes: [
      {
        url: "http://127.0.0.1:8000/v1/bridge/watchlist/AAPL",
        method: "DELETE",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, deleted: true }),
      },
    ],
    chatPrompt: "Remove AAPL from my watchlist",
  },
];

describe("Gesahni tool audit matrix", () => {
  beforeEach(() => {
    resetGesahniGuardrailsForTests();
  });

  it("registers every expected Gesahni tool with schema presence", () => {
    const registered: RegisteredTool[] = [];
    const registeredCommands: Array<{ name: string; requireAuth?: boolean }> = [];
    const api = {
      ...createApi(),
      registerTool(create: (ctx?: unknown) => unknown, options: { name: string }) {
        registered.push({ name: options.name, create });
      },
      registerCommand(command: unknown) {
        const candidate = command as {
          name?: unknown;
          requireAuth?: unknown;
        };
        if (typeof candidate.name === "string") {
          registeredCommands.push({
            name: candidate.name,
            requireAuth:
              typeof candidate.requireAuth === "boolean" ? candidate.requireAuth : undefined,
          });
        }
      },
    } as unknown as OpenClawPluginApi;

    gesahniPlugin.register(api);

    const expected = [...READ_TOOLS, ...WRITE_TOOLS, { registeredName: "gesahni_write_confirm" }];
    expect(registered.map((entry) => entry.name).toSorted()).toEqual(
      expected.map((entry) => entry.registeredName).toSorted(),
    );

    for (const entry of registered) {
      const tool = entry.create(TRUSTED_TELEGRAM_CTX) as { parameters?: { type?: string } };
      expect(tool.parameters?.type).toBe("object");
    }

    expect(registeredCommands).toContainEqual({
      name: "dashboard",
      requireAuth: false,
    });
  });

  it("covers every read-only tool with registration, happy-path, validation, bridge-error, and chat metadata rows", async () => {
    const rows: AuditRow[] = [];

    for (const toolDef of READ_TOOLS) {
      const registrationTools = createGesahniTools({ api: createApi() });
      const tool = registrationTools[toolDef.key] as {
        name: string;
        parameters?: { type?: string };
        execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
      };
      rows.push({
        tool: toolDef.label,
        scenario: "registration",
        expected: `registered as ${toolDef.registeredName} with object schema`,
        actual: `${tool.name} / schema=${tool.parameters?.type ?? "missing"}`,
        status:
          tool.name === toolDef.registeredName && tool.parameters?.type === "object"
            ? "pass"
            : "fail",
        failureLayer: "registration",
        notes: "plugin registration and schema presence",
      });

      const happyFetch = createFetchMock([
        {
          url: toolDef.successUrl,
          headers: {
            Authorization: "Bearer bridge-token",
            "X-User-Id": "tg:999",
          },
          response: asJsonResponse(toolDef.successPayload),
        },
      ]);
      resetGesahniGuardrailsForTests();
      const happyTools = createGesahniTools({
        api: createApi(),
        ctx: TRUSTED_SERVER_CTX,
        fetchImpl: happyFetch,
      });
      const happyResult = (await happyTools[toolDef.key].execute(
        "call-success",
        toolDef.successArgs,
      )) as ToolResult;
      const happyText = extractText(happyResult);
      expect(happyResult.details?.ok).toBe(true);
      for (const snippet of toolDef.successTextIncludes) {
        expect(happyText).toContain(snippet);
      }
      const noPendingConfirm = (await happyTools.writeConfirm.execute(
        "call-no-pending",
        {},
      )) as ToolResult;
      expect(noPendingConfirm.details?.ok).toBe(false);
      rows.push({
        tool: toolDef.label,
        scenario: "happy path",
        expected: `successful read via ${toolDef.successUrl}`,
        actual: happyText.slice(0, 120),
        status: "pass",
        failureLayer: "bridge",
        notes: "read returns content and does not stage pending writes",
      });

      resetGesahniGuardrailsForTests();
      const invalidTools = createGesahniTools({
        api: createApi(),
        ctx: Object.hasOwn(toolDef.invalidArgs, "user_id") ? TRUSTED_SERVER_CTX : undefined,
      });
      const invalidResult = (await invalidTools[toolDef.key].execute(
        "call-invalid",
        toolDef.invalidArgs,
      )) as ToolResult;
      const invalidText = asErrorText(invalidResult);
      expect(invalidResult.details?.ok).toBe(false);
      for (const snippet of toolDef.invalidTextIncludes) {
        expect(invalidText).toContain(snippet);
      }
      const invalidConfirm = (await invalidTools.writeConfirm.execute(
        "call-invalid-confirm",
        {},
      )) as ToolResult;
      expect(invalidConfirm.details?.ok).toBe(false);
      rows.push({
        tool: toolDef.label,
        scenario: "validation edge",
        expected: "clear validation failure with no pending write",
        actual: invalidText.slice(0, 120),
        status: "pass",
        failureLayer: "validation",
        notes: "invalid input stays local and does not touch pending write state",
      });

      const bridgeErrorFetch = createFetchMock([
        {
          url: toolDef.bridgeErrorUrl ?? toolDef.successUrl,
          headers: {
            Authorization: "Bearer bridge-token",
            "X-User-Id": "tg:999",
          },
          response: asJsonResponse(
            toolDef.bridgeErrorPayload ?? { error: "authorization failed" },
            toolDef.bridgeErrorStatus ?? 401,
          ),
        },
      ]);
      resetGesahniGuardrailsForTests();
      const bridgeErrorTools = createGesahniTools({
        api: createApi(),
        ctx: TRUSTED_SERVER_CTX,
        fetchImpl: bridgeErrorFetch,
      });
      const bridgeErrorResult = (await bridgeErrorTools[toolDef.key].execute(
        "call-bridge-error",
        toolDef.bridgeErrorArgs ?? toolDef.successArgs,
      )) as ToolResult;
      const bridgeErrorText = asErrorText(bridgeErrorResult);
      expect(bridgeErrorResult.details?.ok).toBe(false);
      for (const snippet of toolDef.bridgeErrorTextIncludes) {
        expect(bridgeErrorText).toContain(snippet);
      }
      rows.push({
        tool: toolDef.label,
        scenario: "bridge error",
        expected: "actionable bridge failure text",
        actual: bridgeErrorText.slice(0, 120),
        status: "pass",
        failureLayer: "bridge",
        notes: "read path surfaces bridge/auth/not-found failures",
      });

      rows.push({
        tool: toolDef.label,
        scenario: "chat-surface prompt",
        expected: "live gateway chat/tool event validation",
        actual: toolDef.chatPrompt,
        status: "blocked",
        failureLayer: "chat-surface",
        notes: "prompt reserved for live gateway verification; not run in unit audit",
      });
    }

    for (const toolDef of READ_TOOLS) {
      const directRows = rows.filter(
        (row) => row.tool === toolDef.label && row.failureLayer !== "chat-surface",
      );
      expect(directRows).toHaveLength(4);
      expect(directRows.every((row) => row.status === "pass")).toBe(true);
    }

    const report = renderMarkdownTable(rows);
    expect(report).toContain(
      "| Tool | Scenario | Expected | Actual | Status | Failure layer | Notes |",
    );
    expect(report).toContain("| Gesahni Watchlist |");
    expect(report).toContain("| Gesahni Stock Quote |");
  });

  it("rejects explicit user_id from non-telegram untrusted contexts", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ holdings: [], count: 0 }));

    const tools = createGesahniTools({
      api: createApi(),
      fetchImpl: fetchMock,
    });

    const result = (await tools.portfolioGet.execute("call-untrusted", {
      user_id: "tg:999",
    })) as ToolResult;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.details?.ok).toBe(false);
    expect(asErrorText(result)).toContain(
      "explicit user_id is not allowed without trusted server-side binding",
    );
  });

  it("covers every write-preview tool plus confirm with registration, preview, validation, confirmability, and chat metadata rows", async () => {
    const rows: AuditRow[] = [];

    for (const toolDef of WRITE_TOOLS) {
      const registrationTools = createGesahniTools({ api: createApi(), ctx: TRUSTED_TELEGRAM_CTX });
      const tool = registrationTools[toolDef.key] as {
        name: string;
        parameters?: { type?: string };
        execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
      };
      rows.push({
        tool: toolDef.label,
        scenario: "registration",
        expected: `registered as ${toolDef.registeredName} with object schema`,
        actual: `${tool.name} / schema=${tool.parameters?.type ?? "missing"}`,
        status:
          tool.name === toolDef.registeredName && tool.parameters?.type === "object"
            ? "pass"
            : "fail",
        failureLayer: "registration",
        notes: "plugin registration and schema presence",
      });

      const previewExpectations = toolDef.previewRoutes ?? [];
      const previewFetch = createFetchMock(previewExpectations);
      resetGesahniGuardrailsForTests();
      const previewTools = createGesahniTools({
        api: createApi(),
        ctx: {
          ...TRUSTED_TELEGRAM_CTX,
          sessionId: `${String(toolDef.key)}-preview-session`,
        },
        fetchImpl: previewFetch,
      });
      const previewResult = (await previewTools[toolDef.key].execute(
        "call-preview",
        toolDef.previewArgs,
      )) as ToolResult;
      const previewText = extractText(previewResult);
      expect(previewResult.details?.ok).toBe(true);
      expect(previewResult.details?.stage).toBe("preview");
      expect(previewText).toContain("Preview:");
      expect(previewText).toContain("Reply confirm to continue.");
      rows.push({
        tool: toolDef.label,
        scenario: "preview happy path",
        expected: "preview response without executing write immediately",
        actual: previewText.slice(0, 120),
        status: "pass",
        failureLayer: "preview",
        notes: "preview path stages pending action and defers write",
      });

      resetGesahniGuardrailsForTests();
      const invalidTools = createGesahniTools({
        api: createApi(),
        ctx: {
          ...TRUSTED_TELEGRAM_CTX,
          sessionId: `${String(toolDef.key)}-invalid-session`,
        },
        fetchImpl: createFetchMock(toolDef.invalidRoutes ?? []),
      });
      const invalidResult = (await invalidTools[toolDef.key].execute(
        "call-invalid",
        toolDef.invalidArgs,
      )) as ToolResult;
      const invalidText = asErrorText(invalidResult);
      expect(invalidResult.details?.ok).toBe(false);
      for (const snippet of toolDef.invalidTextIncludes) {
        expect(invalidText).toContain(snippet);
      }
      const invalidConfirm = (await invalidTools.writeConfirm.execute(
        "call-invalid-confirm",
        {},
      )) as ToolResult;
      expect(invalidConfirm.details?.ok).toBe(false);
      expect(asErrorText(invalidConfirm)).toContain("no pending write action");
      rows.push({
        tool: toolDef.label,
        scenario: "invalid input",
        expected: "clear validation/lookup failure with no pending write staged",
        actual: invalidText.slice(0, 120),
        status: "pass",
        failureLayer: "validation",
        notes: "invalid preview stays safe and leaves no confirmable action",
      });

      const confirmFetch = createFetchMock([
        ...(toolDef.previewRoutes ?? []),
        ...toolDef.confirmRoutes,
      ]);
      resetGesahniGuardrailsForTests();
      const confirmTools = createGesahniTools({
        api: createApi(),
        ctx: {
          ...TRUSTED_TELEGRAM_CTX,
          sessionId: `${String(toolDef.key)}-confirm-session`,
        },
        fetchImpl: confirmFetch,
      });
      const confirmPreview = (await confirmTools[toolDef.key].execute(
        "call-confirm-preview",
        toolDef.previewArgs,
      )) as ToolResult;
      if (confirmPreview.details?.stage !== "preview") {
        throw new Error(
          `${toolDef.label} preview failed during confirmability check: ${asErrorText(confirmPreview)}`,
        );
      }
      const confirmResult = (await confirmTools.writeConfirm.execute(
        "call-confirm",
        {},
      )) as ToolResult;
      const confirmText = extractText(confirmResult);
      expect(confirmResult.details?.ok).toBe(true);
      expect(confirmResult.details?.payload).toMatchObject({
        stage: "confirmed",
      });
      if (toolDef.confirmTextIncludes) {
        for (const snippet of toolDef.confirmTextIncludes) {
          expect(confirmText).toContain(snippet);
        }
      }
      rows.push({
        tool: toolDef.label,
        scenario: "confirmability",
        expected: "preview creates pending action that confirm executes exactly once",
        actual: confirmText.slice(0, 120),
        status: "pass",
        failureLayer: "confirm",
        notes: "confirm path executes pending action with write auth",
      });

      rows.push({
        tool: toolDef.label,
        scenario: "chat-surface prompt",
        expected: "live gateway chat/tool event validation",
        actual: toolDef.chatPrompt,
        status: "blocked",
        failureLayer: "chat-surface",
        notes: "prompt reserved for live gateway verification; not run in unit audit",
      });
    }

    const confirmTools = createGesahniTools({
      api: createApi(),
      ctx: {
        ...TRUSTED_TELEGRAM_CTX,
        sessionId: "write-confirm-solo-session",
      },
      fetchImpl: createFetchMock([
        {
          url: "http://127.0.0.1:8000/v1/bridge/watchlist",
          method: "POST",
          headers: {
            Authorization: "Bearer bridge-write-token",
            "X-User-Id": "tg:999",
          },
          response: asJsonResponse({ ok: true, created: true }),
        },
      ]),
    });
    await confirmTools.watchlistAdd.execute("call-stage", { command: "AAPL" });
    const validConfirm = (await confirmTools.writeConfirm.execute(
      "call-confirm-valid",
      {},
    )) as ToolResult;
    expect(validConfirm.details?.ok).toBe(true);
    rows.push({
      tool: "Gesahni Write Confirm",
      scenario: "confirm valid pending action",
      expected: "executes one staged write and clears it",
      actual: extractText(validConfirm).slice(0, 120),
      status: "pass",
      failureLayer: "confirm",
      notes: "write confirm completes a staged action",
    });

    const noPendingTools = createGesahniTools({
      api: createApi(),
      ctx: {
        ...TRUSTED_TELEGRAM_CTX,
        sessionId: "write-confirm-empty-session",
      },
    });
    const noPending = (await noPendingTools.writeConfirm.execute(
      "call-confirm-empty",
      {},
    )) as ToolResult;
    expect(noPending.details?.ok).toBe(false);
    expect(asErrorText(noPending)).toContain("no pending write action");
    rows.push({
      tool: "Gesahni Write Confirm",
      scenario: "confirm with no pending action",
      expected: "safe failure with no side effects",
      actual: asErrorText(noPending).slice(0, 120),
      status: "pass",
      failureLayer: "confirm",
      notes: "empty confirm stays safe",
    });

    const replayFetch = createFetchMock([
      {
        url: "http://127.0.0.1:8000/v1/bridge/watchlist",
        method: "POST",
        headers: {
          Authorization: "Bearer bridge-write-token",
          "X-User-Id": "tg:999",
        },
        response: asJsonResponse({ ok: true, created: true }),
      },
    ]);
    const replayTools = createGesahniTools({
      api: createApi(),
      ctx: {
        ...TRUSTED_TELEGRAM_CTX,
        sessionId: "write-confirm-replay-session",
      },
      fetchImpl: replayFetch,
    });
    const replayPreview = (await replayTools.watchlistAdd.execute("call-replay-preview", {
      command: "AAPL",
    })) as ToolResult;
    const pendingActionId = replayPreview.details?.pending_action_id;
    const replayPendingId = typeof pendingActionId === "string" ? pendingActionId : "";
    await replayTools.writeConfirm.execute("call-replay-confirm-1", {
      pending_action_id: replayPendingId,
    });
    const replayResult = (await replayTools.writeConfirm.execute("call-replay-confirm-2", {
      pending_action_id: replayPendingId,
    })) as ToolResult;
    expect(replayResult.details?.ok).toBe(false);
    expect(asErrorText(replayResult)).toContain("no pending write action");
    rows.push({
      tool: "Gesahni Write Confirm",
      scenario: "repeat or mismatched confirm",
      expected: "replay does not execute write twice",
      actual: asErrorText(replayResult).slice(0, 120),
      status: "pass",
      failureLayer: "confirm",
      notes: "replay confirm is rejected after consumption",
    });

    rows.push({
      tool: "Gesahni Write Confirm",
      scenario: "chat-surface prompt",
      expected: "live gateway chat/tool event validation",
      actual: "confirm",
      status: "blocked",
      failureLayer: "chat-surface",
      notes: "prompt reserved for live gateway verification; not run in unit audit",
    });

    for (const toolDef of WRITE_TOOLS) {
      const directRows = rows.filter(
        (row) => row.tool === toolDef.label && row.failureLayer !== "chat-surface",
      );
      expect(directRows).toHaveLength(4);
      expect(directRows.every((row) => row.status === "pass")).toBe(true);
    }
    const writeConfirmRows = rows.filter(
      (row) => row.tool === "Gesahni Write Confirm" && row.failureLayer !== "chat-surface",
    );
    expect(writeConfirmRows).toHaveLength(3);
    expect(writeConfirmRows.every((row) => row.status === "pass")).toBe(true);

    const report = renderMarkdownTable(rows);
    expect(report).toContain("| Gesahni Alert Create |");
    expect(report).toContain("| Gesahni Write Confirm |");
    expect(report).toContain("| blocked | chat-surface |");
  });
});
