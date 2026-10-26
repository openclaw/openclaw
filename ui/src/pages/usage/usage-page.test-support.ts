import { expect, vi } from "vitest";
import { buildUsageOverview } from "../../../../src/shared/usage-overview.js";
import type { UsageOverviewOptions } from "../../../../src/shared/usage-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsUsageResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { page as usageRoute } from "./route.tsx";
import type { UsageRouteData, UsageSessionEntry } from "./types.ts";
import { createUsagePage } from "./usage-page-state.ts";
import { buildAggregatesFromSessions, usageTotals } from "./view.test-support.ts";

export type TestUsagePage = Awaited<ReturnType<typeof createPage>>;

export async function createUsagePageFixture(
  request: (...args: never[]) => unknown,
  renderView = true,
  configure?: (context: ReturnType<typeof contextWithClient>) => void,
) {
  const client = { request } as unknown as GatewayBrowserClient;
  const context = contextWithClient(client);
  configure?.(context);
  const page = await createPage(client, renderView, context);
  return { client, context, page };
}

export async function loadUsagePage(...args: Parameters<typeof createUsagePageFixture>) {
  const fixture = await createUsagePageFixture(...args);
  await preloadUsage(fixture.page);
  return fixture;
}

export function usagePoints(timestamp: number, count: number, cost = 0) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: timestamp + index * 1_000,
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    cost,
    cumulativeTokens: (index + 1) * 100,
    cumulativeCost: (index + 1) * cost,
  }));
}

export async function settleUsageTimers(page: TestUsagePage, milliseconds = 0) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await page.updateComplete;
}

export function usageCalls<T extends readonly unknown[]>(
  request: { mock: { calls: T[] } },
  method = "sessions.usage",
) {
  return request.mock.calls.filter(([name]) => name === method);
}

export function textOf(root: Pick<ParentNode, "querySelector">, selector: string) {
  return root.querySelector(selector)?.textContent;
}

export async function settleUsagePage(page: TestUsagePage) {
  await waitForFast(() => expect(page.usageLoading).toBe(false));
  await page.updateComplete;
}

export async function queryUsagePage(page: TestUsagePage, query: string) {
  const input = page.querySelector<HTMLInputElement>(".usage-query-input")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settleUsagePage(page);
}

export function changeUsageControl(control: HTMLInputElement | HTMLSelectElement, value: string) {
  control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

export function usageButton(page: TestUsagePage, label: string, selector = "button") {
  const button = [...page.querySelectorAll<HTMLButtonElement>(selector)].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
  );
  expect(button).toBeDefined();
  return button!;
}

export function selectUsageSession(page: TestUsagePage, index = 0) {
  page.querySelectorAll<HTMLButtonElement>(".session-bar-selection")[index]!.click();
}

type UsagePublicationFixture = {
  agentId?: string;
  usageUpdatedAt: number;
  usageRefreshFailed?: boolean;
};

export function contextWithClient(client: GatewayBrowserClient): ApplicationContext & {
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  publishUsage: (publication: UsagePublicationFixture) => void;
} {
  const subscribe = () => () => undefined;
  const { gateway, publish } = createApplicationGateway({
    client,
    phase: "connected",
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot);
  const selectionState: ApplicationContext["agentSelection"]["state"] = {
    selectedId: null,
    scopeId: null,
  };
  const selectionListeners = new Set<
    Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0]
  >();
  const setGatewaySnapshot = (patch: Partial<ApplicationGatewaySnapshot>) =>
    publish({ ...gateway.snapshot, ...patch });
  return {
    setGatewaySnapshot,
    publishUsage: ({
      agentId = "main",
      usageUpdatedAt,
      usageRefreshFailed,
    }: UsagePublicationFixture) =>
      setGatewaySnapshot({
        usagePublications: {
          ...gateway.snapshot.usagePublications,
          [agentId]: {
            usageUpdatedAt,
            committedAt: usageRefreshFailed
              ? (gateway.snapshot.usagePublications?.[agentId]?.committedAt ?? 0)
              : usageUpdatedAt,
            usageRefreshFailed: usageRefreshFailed || undefined,
          },
        },
      }),
    basePath: "",
    gateway,
    agents: {
      state: { agentsList: null, agentsLoading: false, agentsError: null },
      ensureList: vi.fn(async () => null),
      subscribe,
    },
    agentIdentity: {
      get: () => null,
      entries: () => [],
      ensure: async () => undefined,
      invalidate: () => undefined,
      subscribe,
    },
    agentSelection: {
      state: selectionState,
      set: vi.fn(),
      setScope: vi.fn((scopeId: string | null) => {
        selectionState.scopeId = scopeId;
        for (const listener of selectionListeners) {
          listener(selectionState);
        }
      }),
      subscribe: (listener: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0]) => {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof contextWithClient>;
}

export async function createPage(
  client: GatewayBrowserClient,
  renderView = false,
  initialContext: ApplicationContext = contextWithClient(client),
) {
  let context = initialContext;
  // Legacy test fixtures describe canonical rows; expose the same server projection
  // as the real RPC so page tests exercise request ownership and presentation.
  const originalRequest = client.request.bind(client);
  client.request = (async (method, params, options) => {
    const result = await originalRequest(method, params, options);
    if (
      method !== "sessions.usage" ||
      !result ||
      typeof result !== "object" ||
      !("sessions" in result) ||
      !("totals" in result)
    ) {
      return result;
    }
    const usage = result as SessionsUsageResult;
    const requestParams = (params ?? {}) as Record<string, unknown>;
    if (usage.overview || requestParams.key) {
      return result;
    }
    const filters = params as UsageOverviewOptions | undefined;
    const projected = buildUsageOverview({
      rows: usage.sessions,
      options: filters ?? {},
      dayBucket:
        requestParams.mode === "specific" && typeof requestParams.timeZone === "string"
          ? { mode: "time-zone", timeZone: requestParams.timeZone }
          : { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    const hasFilters = Boolean(
      filters?.query ||
      filters?.selectedDays?.length ||
      filters?.selectedHours?.length ||
      filters?.selectedSessions?.length,
    );
    return {
      ...usage,
      ...projected,
      ...(!hasFilters ? { totals: usage.totals, aggregates: usage.aggregates } : {}),
      ...(requestParams.projection === "overview"
        ? {}
        : {
            sessions: usage.sessions.filter((session) =>
              projected.sessions.some((row) => row.key === session.key),
            ),
          }),
    };
  }) as GatewayBrowserClient["request"];
  const content = renderView ? (await import("./usage-page.tsx")).UsagePageContent : undefined;
  const container = document.createElement("div");
  let model: ReturnType<typeof createUsagePage>;
  let routeData: UsageRouteData | undefined;
  let disposeView: () => void;
  const mount = () => {
    disposeView = mountSolid(
      () => {
        model = createUsagePage(context);
        return content?.({
          get state() {
            return model.read();
          },
          get result() {
            return model.result();
          },
        });
      },
      {
        container,
        wrapper: content ? createSolidApplicationContextProvider(context).wrapper : undefined,
      },
    ).unmount;
  };
  const page = {
    element: container,
    querySelector: container.querySelector.bind(container),
    querySelectorAll: container.querySelectorAll.bind(container),
    get textContent() {
      return container.textContent;
    },
    get isConnected() {
      return container.isConnected;
    },
    get context() {
      return context;
    },
    set context(next: ApplicationContext) {
      disposeView();
      context = next;
      mount();
      if (routeData) {
        model.setRouteData(routeData);
      }
    },
    get routeData() {
      return routeData;
    },
    set routeData(data: UsageRouteData | undefined) {
      routeData = data;
      model.setRouteData(data);
    },
    get usageResult() {
      return model.result();
    },
    get usageLoading() {
      return model.read().data.loading;
    },
    get usageSelectedSessions() {
      return model.read().filters.selectedSessions;
    },
    read: () => model.read(),
    refresh: async () => {
      await model.read().callbacks.filters.onRefresh();
    },
    get updateComplete() {
      return Promise.resolve().then(() => {
        flush();
        return true;
      });
    },
    remove() {
      disposeView();
      container.remove();
    },
  };
  document.body.append(container);
  mount();
  await page.updateComplete;
  return page;
}

export function focusDocument(): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
}

export function createPendingUsageRouteData(
  gateway: ApplicationContext["gateway"],
  date: string,
): UsageRouteData {
  return {
    gateway,
    gatewaySnapshot: gateway.snapshot,
    query: {
      startDate: date,
      endDate: date,
      scope: "family",
      timeZone: "local",
      agentId: null,
    },
    result: null,
    loadedAtMs: null,
    error: null,
  };
}

export function cleanupUsagePageTest(): void {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

export function contextWeight(name: string): NonNullable<UsageSessionEntry["contextWeight"]> {
  return {
    source: "run",
    generatedAt: 1,
    systemPrompt: { chars: 80, projectContextChars: 20, nonProjectContextChars: 60 },
    skills: { promptChars: 10, entries: [{ name, blockChars: 10 }] },
    tools: { listChars: 0, schemaChars: 0, entries: [] },
    injectedWorkspaceFiles: [],
  };
}

export function cacheSnapshot(status: "fresh" | "partial" | "stale" | "refreshing") {
  const cacheStatus = {
    status,
    cachedFiles: 1,
    pendingFiles: status === "fresh" ? 0 : 1,
    staleFiles: status === "stale" ? 1 : 0,
  };
  const totals = usageTotals(100, 1);
  return {
    result: {
      updatedAt: Date.now(),
      startDate: "2026-08-07",
      endDate: "2026-08-07",
      sessions: [],
      totals,
      aggregates: {
        ...buildAggregatesFromSessions([]),
        costDaily: [],
      },
      cacheStatus,
    } satisfies SessionsUsageResult,
  };
}

export async function preloadUsage(page: TestUsagePage): Promise<void> {
  const options = createRouteLoaderOptions({ pathname: "/usage", search: "", hash: "" });
  page.routeData = (await usageRoute.loader!(page.context, options)) as UsageRouteData;
  await page.updateComplete;
}

/** Tests written against the recent-first session order opt back into it; the page sorts by cost. */
export async function showRecentSessions(page: TestUsagePage): Promise<void> {
  page.read().callbacks.display.onChange({ sessionSort: "recent" });
  await vi.waitFor(() => expect(page.usageLoading).toBe(false));
  await page.updateComplete;
}

export function refreshButton(page: TestUsagePage): HTMLButtonElement {
  return usageButton(page, "Refresh");
}
