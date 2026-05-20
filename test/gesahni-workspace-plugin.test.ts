import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGesahniService,
  createGesahniTools,
  resetGesahniGuardrailsForTests,
} from "../.openclaw/extensions/gesahni/gesahni.ts";
import gesahniPlugin from "../.openclaw/extensions/gesahni/index.js";

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
  sessionId: "workspace-server-session",
};

function createTools(fetchImpl?: typeof fetch) {
  return createGesahniTools({
    api: createApi({
      baseUrl: "http://127.0.0.1:8000",
      readBridgeToken: "bridge-token",
    }),
    ctx: TRUSTED_SERVER_CTX,
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

function resolveDashboardCommand(pluginConfig?: Record<string, unknown>) {
  let registered:
    | {
        name: string;
        requireAuth?: boolean;
        handler: (ctx: {
          channel: string;
          from?: string;
          args?: string;
        }) => Promise<{ text?: string }>;
      }
    | undefined;
  const api = {
    ...createApi({
      baseUrl: "http://127.0.0.1:8000",
      readBridgeToken: "bridge-token",
      ...pluginConfig,
    }),
    registerTool() {},
    registerCommand(command: unknown) {
      const candidate = command as { name?: unknown };
      if (candidate.name === "dashboard") {
        registered = command as typeof registered;
      }
    },
  } as unknown as OpenClawPluginApi;
  gesahniPlugin.register(api);
  expect(registered).toBeDefined();
  return registered!;
}

describe("Gesahni workspace plugin tools", () => {
  beforeEach(() => {
    resetGesahniGuardrailsForTests();
  });

  it("uses tool names compatible with strict tool validators", () => {
    const tools = createTools();

    const names = [
      tools.watchlistGet.name,
      tools.positionsGet.name,
      tools.marketSummaryGet.name,
      tools.alertsGet.name,
      tools.earningsUpcomingGet.name,
      tools.portfolioGet.name,
      tools.optionsPositionsGet.name,
      tools.optionsWatchRulesGet.name,
      tools.optionsStatusGet.name,
      tools.optionsAlertSuggestionsGet.name,
      tools.optionsWatchRuleEventsGet.name,
      tools.optionsChainSnapshotGet.name,
      tools.optionsQuotesBatchGet.name,
      tools.earningsCoverageGet.name,
      tools.earningsRemindersDueGet.name,
      tools.earningsRemindersSentGet.name,
      tools.alertDeliveriesGet.name,
    ];

    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it.each([
    [
      "watchlistGet",
      "/v1/bridge/watchlist",
      { user_id: "tg:999" },
      { watchlist: ["AAPL"], count: 1 },
    ],
    ["positionsGet", "/v1/bridge/positions", { user_id: "tg:999" }, { positions: [], count: 0 }],
    [
      "marketSummaryGet",
      "/v1/bridge/market/summary",
      { user_id: "tg:999" },
      { market_hours: { is_open: true } },
    ],
    ["alertsGet", "/v1/bridge/alerts", { user_id: "tg:999" }, { alerts: [], count: 0 }],
    [
      "earningsUpcomingGet",
      "/v1/bridge/earnings/upcoming?days=14",
      { user_id: "tg:999", days: 14 },
      { events: [], count: 0 },
    ],
    ["portfolioGet", "/v1/bridge/portfolio", { user_id: "tg:999" }, { holdings: [], count: 0 }],
    [
      "optionsPositionsGet",
      "/v1/bridge/options/positions",
      { user_id: "tg:999" },
      { positions: [], count: 0 },
    ],
    [
      "optionsWatchRulesGet",
      "/v1/bridge/options/watch_rules",
      { user_id: "tg:999" },
      { watch_rules: [], count: 0 },
    ],
    ["optionsStatusGet", "/v1/bridge/options/status", { user_id: "tg:999" }, { status: "ok" }],
    [
      "optionsAlertSuggestionsGet",
      "/v1/bridge/options/alert_suggestions",
      { user_id: "tg:999" },
      { suggestions: [], count: 0 },
    ],
    [
      "optionsWatchRuleEventsGet",
      "/v1/bridge/options/watch_rules/rule_1/events",
      { user_id: "tg:999", id: "rule_1" },
      { events: [], count: 0 },
    ],
    [
      "optionsChainSnapshotGet",
      "/v1/bridge/options/chain_snapshot?symbol=AAPL",
      { user_id: "tg:999", symbol: "AAPL" },
      { expirations: ["2026-03-20"] },
    ],
    [
      "optionsQuotesBatchGet",
      "/v1/bridge/options/quotes_batch?symbols=AAPL%2CMSFT",
      { user_id: "tg:999", symbols: "AAPL,MSFT" },
      { quotes: [], count: 0 },
    ],
    [
      "earningsCoverageGet",
      "/v1/bridge/earnings/coverage",
      { user_id: "tg:999" },
      { covered: 2, uncovered: 0, total: 2 },
    ],
    [
      "earningsRemindersDueGet",
      "/v1/bridge/earnings/reminders/due",
      { user_id: "tg:999" },
      { reminders: [], count: 0 },
    ],
    [
      "earningsRemindersSentGet",
      "/v1/bridge/earnings/reminders/sent",
      { user_id: "tg:999" },
      { reminders: [], count: 0 },
    ],
    [
      "alertDeliveriesGet",
      "/v1/bridge/alerts/alert_1/deliveries",
      { user_id: "tg:999", alert_id: "alert_1" },
      { deliveries: [], count: 0 },
    ],
  ] as const)(
    "sends %s to the expected bridge path with X-User-Id",
    async (toolKey, expectedUrl, args, payload) => {
      const fetchMock = vi.fn(async () => asJsonResponse(payload));
      const tools = createTools(fetchMock as unknown as typeof fetch);

      const result = (await tools[toolKey].execute("call-1", args)) as {
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

  it("retries only on 5xx responses", async () => {
    const sleepMock = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(asJsonResponse({ error: "server" }, 500))
      .mockResolvedValueOnce(asJsonResponse({ error: "still" }, 502))
      .mockResolvedValueOnce(asJsonResponse({ positions: [], count: 0 }, 200));

    const tools = createGesahniTools({
      api: createApi({
        baseUrl: "http://127.0.0.1:8000",
        readBridgeToken: "bridge-token",
      }),
      ctx: TRUSTED_SERVER_CTX,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
    });

    const result = (await tools.positionsGet.execute("call-2", {
      user_id: "tg:999",
    })) as { details?: Record<string, unknown> };

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock).toHaveBeenNthCalledWith(1, 300);
    expect(sleepMock).toHaveBeenNthCalledWith(2, 600);
    expect(result.details?.ok).toBe(true);
  });

  it("does not retry on 401/403", async () => {
    const sleepMock = vi.fn(async () => {});
    const fetchMock = vi.fn().mockResolvedValue(asJsonResponse({ error: "nope" }, 401));
    const tools = createGesahniTools({
      api: createApi({
        baseUrl: "http://127.0.0.1:8000",
        readBridgeToken: "bridge-token",
      }),
      ctx: TRUSTED_SERVER_CTX,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
    });

    const result = (await tools.alertsGet.execute("call-3", {
      user_id: "tg:999",
    })) as { details?: Record<string, unknown> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(result.details?.ok).toBe(false);
    expect(asErrorText(result.details?.error)).toContain("authorization failed");
  });

  it("retries on timeout errors", async () => {
    const sleepMock = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce({ name: "AbortError", message: "aborted" })
      .mockResolvedValueOnce(asJsonResponse({ events: [], count: 0 }, 200));

    const tools = createGesahniTools({
      api: createApi({
        baseUrl: "http://127.0.0.1:8000",
        readBridgeToken: "bridge-token",
      }),
      ctx: TRUSTED_SERVER_CTX,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
    });

    const result = (await tools.earningsUpcomingGet.execute("call-4", {
      user_id: "tg:999",
      days: 14,
    })) as { details?: Record<string, unknown> };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(300);
    expect(result.details?.ok).toBe(true);
  });

  it.each([
    ["positionsGet", {}],
    ["portfolioGet", {}],
    ["optionsWatchRulesGet", {}],
    ["optionsStatusGet", {}],
    ["earningsCoverageGet", {}],
    ["earningsRemindersDueGet", {}],
    ["earningsRemindersSentGet", {}],
    ["optionsChainSnapshotGet", { command: "AAPL" }],
    ["optionsQuotesBatchGet", { command: "AAPL MSFT" }],
    ["optionsWatchRuleEventsGet", { command: "rule_1" }],
    ["alertDeliveriesGet", { command: "alert_1" }],
  ] as const)(
    "falls back to trusted telegram DM identity for %s when user_id is omitted",
    async (toolKey, args) => {
      const fetchMock = vi.fn(async () => asJsonResponse({ count: 0 }));
      const tools = createGesahniTools({
        api: createApi({
          baseUrl: "http://127.0.0.1:8000",
          readBridgeToken: "bridge-token",
        }),
        ctx: {
          messageChannel: "telegram",
          agentTo: "telegram:999",
          requesterSenderId: "999",
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: vi.fn(async () => {}),
      });

      const result = (await tools[toolKey].execute("call-fallback", args)) as {
        details?: Record<string, unknown>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
      expect(headers["X-User-Id"]).toBe("tg:999");
      expect(result.details?.ok).toBe(true);
    },
  );

  it.each([
    ["positionsGet", { user_id: "tg:123" }],
    ["portfolioGet", { user_id: "tg:123" }],
    ["optionsWatchRulesGet", { user_id: "tg:123" }],
    ["optionsStatusGet", { user_id: "tg:123" }],
    ["optionsAlertSuggestionsGet", { user_id: "tg:123" }],
    ["optionsWatchRuleEventsGet", { user_id: "tg:123", id: "rule_1" }],
    ["optionsChainSnapshotGet", { user_id: "tg:123", symbol: "AAPL" }],
    ["optionsQuotesBatchGet", { user_id: "tg:123", symbols: "AAPL,MSFT" }],
    ["earningsCoverageGet", { user_id: "tg:123" }],
    ["earningsRemindersDueGet", { user_id: "tg:123" }],
    ["earningsRemindersSentGet", { user_id: "tg:123" }],
    ["alertDeliveriesGet", { user_id: "tg:123", alert_id: "alert_1" }],
  ] as const)(
    "rejects mismatched trusted telegram identity before fetch for %s",
    async (toolKey, args) => {
      const fetchMock = vi.fn(async () => asJsonResponse({ count: 0 }));
      const tools = createGesahniTools({
        api: createApi({
          baseUrl: "http://127.0.0.1:8000",
          readBridgeToken: "bridge-token",
        }),
        ctx: {
          messageChannel: "telegram",
          agentTo: "telegram:999",
          requesterSenderId: "999",
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: vi.fn(async () => {}),
      });

      const result = (await tools[toolKey].execute("call-mismatch", args)) as {
        details?: Record<string, unknown>;
      };

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.details?.ok).toBe(false);
      expect(asErrorText(result.details?.error)).toContain(
        "does not match trusted runtime identity",
      );
    },
  );

  it("caches chain snapshot reads for the same user and symbol", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ expirations: ["2026-03-20"] }));
    const tools = createTools(fetchMock as unknown as typeof fetch);

    await tools.optionsChainSnapshotGet.execute("call-1", { user_id: "tg:999", symbol: "AAPL" });
    await tools.optionsChainSnapshotGet.execute("call-2", { user_id: "tg:999", symbol: "AAPL" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a degraded response when chain snapshot rate limits are exceeded", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      return asJsonResponse({
        expirations: [`${headers?.["X-User-Id"] ?? "unknown"}-${fetchMock.mock.calls.length}`],
      });
    });
    const tools = createTools(fetchMock as unknown as typeof fetch);

    await tools.optionsChainSnapshotGet.execute("call-1", { user_id: "tg:999", symbol: "AAPL" });
    await tools.optionsChainSnapshotGet.execute("call-2", { user_id: "tg:999", symbol: "MSFT" });
    await tools.optionsChainSnapshotGet.execute("call-3", { user_id: "tg:999", symbol: "NVDA" });
    await tools.optionsChainSnapshotGet.execute("call-4", { user_id: "tg:999", symbol: "AMD" });
    const result = (await tools.optionsChainSnapshotGet.execute("call-5", {
      user_id: "tg:999",
      symbol: "TSLA",
    })) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.details?.ok).toBe(false);
    expect(String(result.content?.[0]?.text ?? "")).toContain("try again");
  });

  it("caches quotes batch reads for the same user and symbol set", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ quotes: [{ symbol: "AAPL" }], count: 1 }));
    const tools = createTools(fetchMock as unknown as typeof fetch);

    await tools.optionsQuotesBatchGet.execute("call-1", {
      user_id: "tg:999",
      symbols: "AAPL,MSFT",
    });
    await tools.optionsQuotesBatchGet.execute("call-2", {
      user_id: "tg:999",
      symbols: "AAPL MSFT",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces a hard cap on quotes batch size", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ quotes: [], count: 0 }));
    const tools = createTools(fetchMock as unknown as typeof fetch);
    const tooMany = Array.from({ length: 21 }, (_, index) => `SYM${index}`).join(",");

    const result = (await tools.optionsQuotesBatchGet.execute("call-many", {
      user_id: "tg:999",
      symbols: tooMany,
    })) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.details?.ok).toBe(false);
    expect(String(result.content?.[0]?.text ?? "")).toContain("at most 20 symbols");
  });

  it.each([
    ["optionsWatchRuleEventsGet", { user_id: "tg:999", id: "fake_rule_id" }, 500],
    ["optionsWatchRuleEventsGet", { user_id: "tg:999", id: "fake_rule_id" }, 422],
    ["alertDeliveriesGet", { user_id: "tg:999", alert_id: "fake_alert_id" }, 500],
    ["alertDeliveriesGet", { user_id: "tg:999", alert_id: "fake_alert_id" }, 422],
  ] as const)(
    "returns a clean id-not-found style error for %s when bridge returns %s",
    async (toolKey, args, status) => {
      const fetchMock = vi.fn(async () => asJsonResponse({ error: "no record" }, status));
      const tools = createTools(fetchMock as unknown as typeof fetch);

      const result = (await tools[toolKey].execute("call-not-found", args)) as {
        details?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.details?.ok).toBe(false);
      const bodyText = String(result.content?.[0]?.text ?? "");
      expect(bodyText).toContain("not found");
      expect(bodyText).not.toContain("(500)");
      expect(bodyText).not.toContain("(422)");
    },
  );

  it("posts link-initiate through the shared bridge request path", async () => {
    const fetchMock = vi.fn(async () =>
      asJsonResponse({ connect_url: "https://dashboard.example/connect/token" }),
    );
    const service = createGesahniService({
      config: {
        baseUrl: "http://127.0.0.1:8000",
        readBridgeToken: "bridge-token",
        writeBridgeToken: "",
        defaultTimeoutMs: 2500,
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: vi.fn(async () => {}),
    });

    await service.linkInitiate({ userId: "tg:999" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8000/v1/bridge/link/initiate");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bridge-token");
    expect(headers["X-User-Id"]).toBe("tg:999");
  });

  it("rejects explicit user_id outside trusted runtime binding", async () => {
    const fetchMock = vi.fn(async () => asJsonResponse({ holdings: [], count: 0 }));
    const tools = createGesahniTools({
      api: createApi({
        baseUrl: "http://127.0.0.1:8000",
        readBridgeToken: "bridge-token",
      }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: vi.fn(async () => {}),
    });

    const result = (await tools.portfolioGet.execute("call-untrusted", {
      user_id: "tg:999",
    })) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.details?.ok).toBe(false);
    expect(asErrorText(result.details?.error)).toContain(
      "explicit user_id is not allowed without trusted server-side binding",
    );
  });

  it("runs /dashboard only for trusted Telegram DM contexts and accepts connect_url or dashboard_url", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        asJsonResponse({ connect_url: "https://dashboard.example/connect/token" }),
      )
      .mockImplementationOnce(async () =>
        asJsonResponse({ dashboard_url: "https://dashboard.example/connect/fallback" }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    try {
      const command = resolveDashboardCommand();
      const dmResult = await command.handler({
        channel: "telegram",
        from: "telegram:999",
      });
      expect(dmResult.text).toContain("https://dashboard.example/connect/token");

      const fallbackResult = await command.handler({
        channel: "telegram",
        from: "telegram:999",
      });
      expect(fallbackResult.text).toContain("https://dashboard.example/connect/fallback");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("http://127.0.0.1:8000/v1/bridge/link/initiate");
      expect((init as RequestInit | undefined)?.method).toBe("POST");
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
      expect(headers["X-User-Id"]).toBe("tg:999");

      const nonDmResult = await command.handler({
        channel: "telegram",
        from: "telegram:group:999",
      });
      expect(nonDmResult.text).toContain("only works in Telegram direct messages");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns clear /dashboard errors for malformed bridge response, bridge failure, and timeout/network", async () => {
    const command = resolveDashboardCommand();
    try {
      const missingUrlFetch = vi.fn(async () => asJsonResponse({ ok: true }));
      vi.stubGlobal("fetch", missingUrlFetch as unknown as typeof fetch);
      const missingUrlResult = await command.handler({
        channel: "telegram",
        from: "telegram:999",
      });
      expect(missingUrlResult.text).toContain("missing connect_url or dashboard_url");

      const bridgeFailureFetch = vi.fn(async () => asJsonResponse({ error: "nope" }, 422));
      vi.stubGlobal("fetch", bridgeFailureFetch as unknown as typeof fetch);
      const bridgeFailureResult = await command.handler({
        channel: "telegram",
        from: "telegram:999",
      });
      expect(bridgeFailureResult.text).toContain("Please try again.");

      const timeoutFetch = vi.fn(async () => {
        throw new Error("bridge request timed out (2500ms)");
      });
      vi.stubGlobal("fetch", timeoutFetch as unknown as typeof fetch);
      const timeoutResult = await command.handler({
        channel: "telegram",
        from: "telegram:999",
      });
      expect(timeoutResult.text).toContain("timed out");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
