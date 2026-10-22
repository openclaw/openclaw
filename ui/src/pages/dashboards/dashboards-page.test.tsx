/* @vitest-environment jsdom */

import type { BoardGetParams, BoardSnapshot } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import type { SessionListOptions, SessionListSnapshot } from "../../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import { sessionChanged } from "../../lib/sessions/session-rpc.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createSolidApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { page as dashboardRoute } from "./route.ts";
import type { DashboardsRouteData } from "./view.tsx";

function pageContext(overrides: {
  sessions: Partial<ApplicationContext["sessions"]>;
  gateway?: ApplicationContext["gateway"];
  agentSelection?: Partial<ApplicationContext["agentSelection"]>;
}): ApplicationContext {
  return {
    basePath: "",
    gateway: createApplicationGateway().gateway,
    agentSelection: { state: { selectedId: "main", scopeId: null }, subscribe: () => () => {} },
    agents: { state: { agentsList: null } },
    ...overrides,
  } as ApplicationContext;
}

async function mountDashboard(context: ApplicationContext, initial?: DashboardsRouteData) {
  const [data, setData] = createSignal(initial);
  const { renderSolid: Page } = await dashboardRoute.component();
  return {
    ...mountSolid(() => <Page data={data()} loaderPending={false} presented />, {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    }),
    setData,
  };
}

function cardTitles(element: HTMLElement) {
  return Array.from(element.querySelectorAll("[data-dashboard-session] h2"), (heading) =>
    heading.textContent?.trim(),
  );
}

function row(
  key: string,
  displayName: string,
  extras: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key, kind: "direct", boardFace: "dashboard", displayName, updatedAt: 1, ...extras };
}

function routeData(...rows: GatewaySessionRow[]): DashboardsRouteData {
  return {
    result: sessionsResult(rows),
    error: null,
    basePath: "",
    fallbackAgentId: "main",
    mainKey: "main",
    globalScope: false,
  };
}

function snapshot(
  listResult: SessionsListResult | null,
  agentId: string | null = null,
  error: string | null = null,
): SessionListSnapshot {
  return { result: listResult, agentId, loading: false, error };
}

function changeValue(control: HTMLInputElement | HTMLSelectElement, value: string, settle = true) {
  control.value = value;
  control.dispatchEvent(
    new Event(control instanceof HTMLInputElement ? "input" : "change", { bubbles: true }),
  );
  if (settle) {
    flush();
  }
}

function createDashboardClient() {
  return createTestGatewayClient(async (method, params) => {
    if (method !== "board.get") {
      throw new Error(`Unexpected Gateway method: ${method}`);
    }
    const { sessionKey } = params as BoardGetParams;
    return { sessionKey, revision: 1, tabs: [], widgets: [] } satisfies BoardSnapshot;
  });
}

function controlPreviewFrames(): () => void {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(requestAnimationFrame);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelAnimationFrame);
  return () => vi.advanceTimersToNextFrame();
}

async function settleDashboardPreviews(element: HTMLElement, runFrame: () => void) {
  flush();
  runFrame();
  flush();
  const previews = element.querySelectorAll<HTMLElement>("openclaw-dashboard-preview");
  expect(previews.length).toBeGreaterThan(0);
  const selector = 'openclaw-board-document openclaw-board-view [data-test-id="board-empty"]';
  for (const preview of previews) {
    await waitForSolid(
      () => expect(preview.querySelector(selector), preview.textContent ?? "").not.toBeNull(),
      { timeout: 10_000 },
    );
  }
}

describe("DashboardsPage", () => {
  beforeEach(() => i18n.setLocale("en"));

  afterEach(() => {
    cleanupSolid();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("subscribes to the exact query and preserves owner rows through agent-scope and route updates", async () => {
    const runFrame = controlPreviewFrames();
    const selectionState = { selectedId: "main", scopeId: null as string | null };
    const selectionListeners = new Set<(state: typeof selectionState) => void>();
    const listListeners = new Map<string, (snapshot: SessionListSnapshot) => void>();
    const snapshots = new Map<string, SessionListSnapshot>();
    const queryKey = (options: SessionListOptions) => options.agentId ?? "all";
    const allResult = sessionsResult([row("agent:main:before", "Before")]);
    snapshots.set("all", snapshot(allResult));
    snapshots.set("writer", snapshot(null));
    const refreshList = vi.fn(async () => undefined);
    const subscribeList = vi.fn(
      (query: SessionListOptions, listener: (snapshot: SessionListSnapshot) => void) => {
        const key = queryKey(query);
        listListeners.set(key, listener);
        return () => listListeners.delete(key);
      },
    );
    const source = createApplicationGateway();
    source.publish({
      ...source.gateway.snapshot,
      client: createDashboardClient(),
      phase: "connected",
    });
    const context = pageContext({
      gateway: source.gateway,
      sessions: {
        listSnapshot(query: SessionListOptions) {
          return snapshots.get(queryKey(query))!;
        },
        subscribeList,
        refreshList,
      },
      agentSelection: {
        state: selectionState,
        subscribe(listener) {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      },
    });
    const mounted = await mountDashboard(context, routeData(row("agent:main:before", "Before")));
    const element = mounted.container;
    flush();

    const expectedQuery = {
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      rowMode: "dashboard",
      source: "dashboard",
      excludeDock: true,
      hasBoard: true,
      archivedFilter: "all",
    };
    expect(subscribeList).toHaveBeenCalledWith(expectedQuery, expect.any(Function));
    expect(refreshList).not.toHaveBeenCalled();
    const retiredListener = listListeners.get("all")!;

    selectionState.scopeId = "writer";
    selectionListeners.forEach((listener) => listener(selectionState));
    await waitForSolid(() => expect(refreshList).toHaveBeenCalledTimes(1));
    expect(refreshList).toHaveBeenCalledWith({ ...expectedQuery, agentId: "writer" });
    expect(element.textContent).toContain("Before");

    const publishWriter = (title: string | null, error: string | null = null) => {
      const next = snapshot(
        title === null ? null : sessionsResult([row("agent:writer:current", title)]),
        "writer",
        error,
      );
      snapshots.set("writer", next);
      listListeners.get("writer")?.(next);
      flush();
    };
    publishWriter(null, "Writer initial load failed");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Writer initial load failed",
    );
    expect(element.querySelector('[aria-busy="true"]')).toBeNull();
    expect(refreshList).toHaveBeenCalledTimes(1);

    publishWriter("Writer dashboard");
    await waitForSolid(() => expect(element.textContent).toContain("Writer dashboard"));
    mounted.setData(undefined);
    flush();
    expect(element.textContent).toContain("Writer dashboard");
    mounted.setData(routeData(row("agent:main:stale-route", "Stale route")));
    flush();
    expect(element.textContent).toContain("Writer dashboard");
    expect(element.textContent).not.toContain("Stale route");
    await settleDashboardPreviews(element, runFrame);
    retiredListener(
      snapshot(
        sessionsResult([row("agent:main:retired", "Retired")]),
        null,
        "Retired scope refresh failed",
      ),
    );
    flush();
    expect(element.textContent).not.toContain("Retired");

    const writerListener = listListeners.get("writer")!;
    publishWriter("Writer dashboard", "Writer refresh failed");
    expect(element.textContent).toContain("Writer dashboard");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("Writer refresh failed");
    expect(element.querySelector('[role="alert"] button')).toBeNull();
    publishWriter("Recovered dashboard");
    await settleDashboardPreviews(element, runFrame);
    expect(element.textContent).toContain("Recovered dashboard");
    expect(element.querySelector('[role="alert"]')).toBeNull();

    mounted.unmount();
    writerListener(snapshot(null, "writer", "Detached refresh failed"));
    flush();
    expect(element.textContent).not.toContain("Detached refresh failed");
  });

  it.each([false, true])(
    "keeps pages across row events; retires late pages: %s",
    async (retired) => {
      const runFrame = controlPreviewFrames();
      const firstRow = row("agent:main:new", "New dashboard", { sessionId: "new", hasBoard: true });
      const secondRow = row("agent:main:old", "Old dashboard", {
        sessionId: "old",
        hasBoard: true,
      });
      const page = (rows: GatewaySessionRow[], offset: number, hasMore: boolean) => ({
        ...sessionsResult(rows),
        totalCount: 2,
        offset,
        limitApplied: 1,
        hasMore,
        nextOffset: hasMore ? 1 : null,
      });
      const pendingPage = Promise.withResolvers<SessionsListResult>();
      const requests: unknown[] = [];
      const boardClient = createDashboardClient();
      const client = createTestGatewayClient(async (method, params) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          if (!Reflect.get(params ?? {}, "hasBoard")) {
            return sessionsResult([]);
          }
          requests.push(params);
          return Reflect.get(params ?? {}, "offset")
            ? retired
              ? pendingPage.promise
              : page([secondRow], 1, false)
            : page([firstRow], 0, true);
        }
        return boardClient.request(method, params);
      });
      const source = createApplicationGateway();
      source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
      const sessions = createTestSessionCapability(source.gateway);
      const context = pageContext({ gateway: source.gateway, sessions });
      const mounted = await mountDashboard(context);
      const element = mounted.container;
      try {
        await waitForSolid(() => expect(requests).toHaveLength(2));
        if (retired) {
          source.publish({ ...source.gateway.snapshot, phase: "reconnecting", client: null });
          pendingPage.resolve(page([secondRow], 1, false));
          flush();
          expect(element.textContent).toContain("New dashboard");
          expect(element.textContent).not.toContain("Old dashboard");
          return;
        }
        await waitForSolid(() =>
          expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(2),
        );
        await settleDashboardPreviews(element, runFrame);
        source.publishEvent(
          sessionChanged({
            reason: "patch",
            sessionKey: firstRow.key,
            ancestorSessions: [],
            session: { ...firstRow, displayName: "Updated dashboard", updatedAt: 2 },
          }),
        );
        flush();
        expect(cardTitles(element)).toEqual(["Updated dashboard", "Old dashboard"]);
        expect(requests).toHaveLength(2);
        expect(sessions.listSnapshot(dashboardSessionListQuery()).result?.sessions).toHaveLength(2);
        const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
        changeValue(search, "old");
        expect(cardTitles(element)).toEqual(["Old dashboard"]);
      } finally {
        pendingPage.resolve(page([secondRow], 1, false));
        mounted.unmount();
        sessions.dispose();
      }
    },
  );

  it("renders the route host and filters by search and author and sorts cards by title", async () => {
    const data = routeData(
      row("agent:main:dashboard:zulu", "Zulu monitor", {
        updatedAt: 30,
        createdActor: { type: "human", id: "peter", label: "Peter" },
      }),
      row("agent:main:dashboard:alpha", "Alpha signals", {
        updatedAt: 10,
        createdActor: { type: "human", id: "mira", label: "Mira" },
      }),
      row("agent:main:dashboard:bravo", "Bravo health", {
        updatedAt: 20,
        createdActor: { type: "human", id: "peter", label: "Peter" },
      }),
    );
    const context = pageContext({
      sessions: {
        listSnapshot: () => snapshot(null),
        subscribeList: () => () => {},
      },
    });
    const { container } = await mountDashboard(context, data);
    flush();

    const element = container.querySelector<HTMLElement>("openclaw-dashboards-page")!;
    expect(element).not.toBeNull();
    expect(cardTitles(element)).toEqual(["Zulu monitor", "Bravo health", "Alpha signals"]);
    expect(element.querySelector(".dashboard-preview")?.hasAttribute("inert")).toBe(true);

    const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search).not.toBeNull();
    changeValue(search, "signals");
    expect(cardTitles(element)).toEqual(["Alpha signals"]);

    changeValue(search, "");
    const selects = element.querySelectorAll<HTMLSelectElement>("select");
    const authorSelect = selects.item(0);
    const sortSelect = selects.item(1);
    changeValue(authorSelect, "mira");
    expect(cardTitles(element)).toEqual(["Alpha signals"]);
    expect(element.textContent).toContain("By Mira");

    changeValue(authorSelect, "", false);
    changeValue(sortSelect, "title");
    expect(cardTitles(element)).toEqual(["Alpha signals", "Bravo health", "Zulu monitor"]);
  });
});
