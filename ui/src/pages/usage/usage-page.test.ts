/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { UsageRouteData } from "./route-data.ts";
import "./usage-page.ts";

type UsageResult = NonNullable<UsageRouteData["result"]>;
type UsageCostSummary = NonNullable<UsageRouteData["costSummary"]>;

type TestUsagePage = HTMLElement & {
  context: ApplicationContext;
  render: () => unknown;
  routeData: UsageRouteData;
  readonly updateComplete: Promise<boolean>;
  usageCacheRefresh: { displayState: "ready" | "rebuilding" | "paused" };
  usageRequestKind: "idle" | "foreground" | "background";
  usageResult: UsageRouteData["result"];
};

const totals = {
  input: 80,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 100,
  totalCost: 1,
  inputCost: 0.8,
  outputCost: 0.2,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

function usageResult(status: "fresh" | "refreshing"): UsageResult {
  return {
    updatedAt: Date.now(),
    startDate: "2026-07-15",
    endDate: "2026-07-15",
    sessions: [],
    totals,
    aggregates: {
      messages: {
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      daily: [],
    },
    cacheStatus: {
      status,
      cachedFiles: status === "fresh" ? 1 : 0,
      pendingFiles: status === "fresh" ? 0 : 1,
      staleFiles: status === "fresh" ? 0 : 1,
    },
  };
}

function costSummary(status: "fresh" | "refreshing"): UsageCostSummary {
  return {
    updatedAt: Date.now(),
    days: 1,
    daily: [],
    totals,
    cacheStatus: {
      status,
      cachedFiles: status === "fresh" ? 1 : 0,
      pendingFiles: status === "fresh" ? 0 : 1,
      staleFiles: status === "fresh" ? 0 : 1,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createContext(client: GatewayBrowserClient): ApplicationContext {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway: {
      snapshot,
      eventLog: [],
      subscribe,
      subscribeEvents: subscribe,
      subscribeEventLog: subscribe,
    },
    agents: {
      state: { agentsList: null, agentsLoading: false, agentsError: null },
      ensureList: vi.fn(async () => null),
      subscribe,
    },
    agentIdentity: { get: () => undefined, ensure: vi.fn(async () => undefined), subscribe },
    agentSelection: {
      state: { selectedId: null, scopeId: null },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    channels: { subscribe },
    runtimeConfig: { state: { configSnapshot: null }, subscribe },
    sessions: { state: { result: null, loading: false }, subscribe },
    workboard: { subscribe },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

async function mountPage(
  client: GatewayBrowserClient,
  initialResult = usageResult("refreshing"),
  initialCostSummary = costSummary("refreshing"),
): Promise<TestUsagePage> {
  const context = createContext(client);
  const page = document.createElement("openclaw-usage-page") as TestUsagePage;
  page.context = context;
  page.render = () => nothing;
  page.routeData = {
    gateway: context.gateway,
    gatewaySnapshot: context.gateway.snapshot,
    query: {
      startDate: "2026-07-15",
      endDate: "2026-07-15",
      scope: "family",
      timeZone: "local",
      agentId: null,
    },
    result: initialResult,
    costSummary: initialCostSummary,
    providerUsageSummary: null,
    error: null,
  };
  document.body.append(page);
  await page.updateComplete;
  return page;
}

function requestCount(request: ReturnType<typeof vi.fn>, method: string): number {
  return request.mock.calls.filter(([calledMethod]) => calledMethod === method).length;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UsagePage cache refresh polling", () => {
  it("waits for the active refresh before polling again and stops when both snapshots are fresh", async () => {
    const sessionsRefresh = deferred<UsageResult>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.usage") {
        return sessionsRefresh.promise;
      }
      if (method === "usage.cost") {
        return Promise.resolve(costSummary("fresh"));
      }
      return Promise.resolve({});
    });
    const page = await mountPage({ request } as unknown as GatewayBrowserClient);

    await vi.runOnlyPendingTimersAsync();
    expect(requestCount(request, "sessions.usage")).toBe(1);
    expect(requestCount(request, "usage.cost")).toBe(1);
    expect(requestCount(request, "usage.status")).toBe(0);
    expect(page.usageRequestKind).toBe("background");

    await vi.runOnlyPendingTimersAsync();
    expect(requestCount(request, "sessions.usage")).toBe(1);

    sessionsRefresh.resolve(usageResult("fresh"));
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.usageRequestKind).toBe("idle");
    expect(page.usageResult?.cacheStatus?.status).toBe("fresh");

    await vi.runOnlyPendingTimersAsync();
    expect(requestCount(request, "sessions.usage")).toBe(1);
  });

  it("clears a scheduled refresh when the page disconnects", async () => {
    const request = vi.fn(async () => usageResult("fresh"));
    const page = await mountPage({ request } as unknown as GatewayBrowserClient);

    page.remove();
    await vi.runAllTimersAsync();

    expect(request).not.toHaveBeenCalled();
  });

  it("does not resume polling when an active refresh settles after disconnect", async () => {
    const sessionsRefresh = deferred<UsageResult>();
    const request = vi.fn((method: string) =>
      method === "sessions.usage" ? sessionsRefresh.promise : Promise.resolve(costSummary("fresh")),
    );
    const page = await mountPage({ request } as unknown as GatewayBrowserClient);

    await vi.runOnlyPendingTimersAsync();
    expect(requestCount(request, "sessions.usage")).toBe(1);

    page.remove();
    sessionsRefresh.resolve(usageResult("refreshing"));
    await vi.runAllTimersAsync();

    expect(requestCount(request, "sessions.usage")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses after the bounded refresh budget is exhausted", async () => {
    const request = vi.fn((method: string) =>
      Promise.resolve(
        method === "sessions.usage" ? usageResult("refreshing") : costSummary("refreshing"),
      ),
    );
    const page = await mountPage({ request } as unknown as GatewayBrowserClient);

    await vi.runAllTimersAsync();

    expect(requestCount(request, "sessions.usage")).toBe(60);
    expect(requestCount(request, "usage.cost")).toBe(60);
    expect(page.usageCacheRefresh.displayState).toBe("paused");
    expect(vi.getTimerCount()).toBe(0);
  });
});
