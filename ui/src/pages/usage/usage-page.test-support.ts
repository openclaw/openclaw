import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { createMemo, createSignal } from "solid-js";
import { expect, vi } from "vitest";
import { buildUsageOverview, mergeUsageOverviews } from "../../../../src/shared/usage-overview.js";
import type { UsageOverviewOptions } from "../../../../src/shared/usage-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsUsageResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { UsageDetailsController } from "./detail-controller.ts";
import type { UsageRefreshPolicy } from "./refresh-policy.ts";
import { page as usageRoute } from "./route.ts";
import type { UsageSessionEntry } from "./types.ts";
import { UsagePageModel, type UsageRouteData } from "./usage-page-model.ts";

export type TestUsagePage = Pick<
  HTMLElement,
  "querySelector" | "querySelectorAll" | "textContent" | "isConnected" | "remove"
> & {
  readonly element: HTMLElement;
  context: ApplicationContext;
  routeData: UsageRouteData | undefined;
  usageError: string | null;
  readonly usageResult: SessionsUsageResult | null;
  readonly usageLoading: boolean;
  usageSelectedSessions: string[];
  details: UsageDetailsController;
  providerUsageStalled: boolean;
  providerUsageSummary: { updatedAt: number; providers: unknown[] } | null;
  providerUsageUnavailable: boolean;
  readonly refreshPolicy: UsageRefreshPolicy;
  readonly gateway: {
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
  };
  loadUsage: () => Promise<void>;
  requestUpdate: () => void;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

type InspectedUsagePageModel = Pick<
  TestUsagePage,
  | "details"
  | "loadUsage"
  | "providerUsageSummary"
  | "usageSelectedSessions"
  | "refreshPolicy"
  | "gateway"
>;

const pageCleanups = new Set<() => void>();

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
  let snapshot = {
    client,
    phase: "connected",
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const selectionState: ApplicationContext["agentSelection"]["state"] = {
    selectedId: null,
    scopeId: null,
  };
  const selectionListeners = new Set<
    Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0]
  >();
  const setGatewaySnapshot = (patch: Partial<ApplicationGatewaySnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  return {
    setGatewaySnapshot,
    publishUsage: ({
      agentId = "main",
      usageUpdatedAt,
      usageRefreshFailed,
    }: UsagePublicationFixture) =>
      setGatewaySnapshot({
        usagePublications: {
          ...snapshot.usagePublications,
          [agentId]: {
            usageUpdatedAt,
            committedAt: usageRefreshFailed
              ? (snapshot.usagePublications?.[agentId]?.committedAt ?? 0)
              : usageUpdatedAt,
            usageRefreshFailed: usageRefreshFailed || undefined,
          },
        },
      }),
    basePath: "",
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    agents: {
      state: { agentsList: null, agentsLoading: false, agentsError: null },
      ensureList: vi.fn(async () => null),
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
  context: ApplicationContext = contextWithClient(client),
): Promise<TestUsagePage> {
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
    const slice = buildUsageOverview({
      sessions: usage.sessions.map(({ usage: _usage, contextWeight: _context, ...session }) => ({
        ...session,
        agentId: session.agentId ?? "main",
        instances: [{ sessionFile: "fixture" }],
      })),
      summaries: usage.sessions.map((session) => session.usage),
      options: filters ?? {},
      dayBucket:
        requestParams.mode === "specific" && typeof requestParams.timeZone === "string"
          ? { mode: "time-zone", timeZone: requestParams.timeZone }
          : { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    const projected = mergeUsageOverviews([slice], filters ?? {});
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
  const [revision, setRevision] = createSignal(0);
  const notify = () => setRevision((value) => value + 1);
  let model = new UsagePageModel(context, notify);
  let disposeView: (() => void) | undefined;
  let disposed = false;
  const inspect = () => model as unknown as InspectedUsagePageModel;
  const mount = () => {
    model.connect();
    if (content) {
      disposeView = mountSolid(
        () => {
          const state = createMemo(() => {
            revision();
            return model.read();
          });
          return content({
            get state() {
              return state();
            },
            context: model.context,
            get result() {
              revision();
              return model.usageResult;
            },
          });
        },
        { container },
      ).unmount;
    }
  };
  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    disposeView?.();
    model.dispose();
    pageCleanups.delete(cleanup);
  };
  const page: TestUsagePage = {
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
      return model.context;
    },
    set context(next: ApplicationContext) {
      const routeData = model.routeData;
      disposeView?.();
      model.dispose();
      model = new UsagePageModel(next, notify);
      disposed = false;
      pageCleanups.add(cleanup);
      mount();
      if (routeData) {
        model.setRouteData(routeData);
      }
      notify();
    },
    get routeData() {
      return model.routeData;
    },
    set routeData(data: UsageRouteData | undefined) {
      model.setRouteData(data);
    },
    get usageError() {
      return model.read().data.error;
    },
    get usageResult() {
      return model.usageResult;
    },
    get usageLoading() {
      return model.read().data.loading;
    },
    get usageSelectedSessions() {
      return model.read().filters.selectedSessions;
    },
    set usageSelectedSessions(sessions: string[]) {
      inspect().usageSelectedSessions = sessions;
      notify();
    },
    get details() {
      return inspect().details;
    },
    get providerUsageStalled() {
      return model.read().data.providerUsageStalled;
    },
    get providerUsageSummary() {
      return inspect().providerUsageSummary;
    },
    get providerUsageUnavailable() {
      return model.read().data.providerUsageUnavailable;
    },
    get refreshPolicy() {
      return inspect().refreshPolicy;
    },
    get gateway() {
      return inspect().gateway;
    },
    loadUsage: () => inspect().loadUsage(),
    requestUpdate: notify,
    render: () => undefined,
    get updateComplete() {
      return Promise.resolve().then(() => {
        flush();
        return true;
      });
    },
    remove() {
      cleanup();
      container.remove();
    },
  };
  document.body.append(container);
  pageCleanups.add(cleanup);
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
    costSummary: null,
    providerUsage: { state: "pending" },
    loadedAtMs: null,
    error: null,
  };
}

export function cleanupUsagePageTest(): void {
  for (const cleanup of pageCleanups) {
    cleanup();
  }
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
  const totals = {
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    totalCost: 1,
    inputCost: 1,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
  return {
    result: {
      updatedAt: Date.now(),
      startDate: "2026-08-07",
      endDate: "2026-08-07",
      sessions: [],
      totals,
      aggregates: {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
        costDaily: [],
      },
      cacheStatus,
    } satisfies SessionsUsageResult,
  };
}

export async function preloadUsage(page: TestUsagePage): Promise<void> {
  const options = {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/usage", search: "", hash: "" },
    deps: "",
    cause: "navigation",
  } satisfies RouteLoaderOptions;
  page.routeData = (await usageRoute.loader!(page.context, options)) as UsageRouteData;
  await page.updateComplete;
}

export function refreshButton(page: TestUsagePage): HTMLButtonElement {
  const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === "Refresh",
  );
  expect(button).toBeDefined();
  return button!;
}
