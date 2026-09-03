/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import type { SessionListOptions, SessionListSnapshot } from "../../lib/sessions/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { DashboardsRouteData } from "./view.ts";
import "./dashboards-page.ts";

type DashboardsPageElement = HTMLElement & {
  routeData?: DashboardsRouteData;
  updateComplete: Promise<boolean>;
};

function results(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function result(sessionRow: GatewaySessionRow): SessionsListResult {
  return results([sessionRow]);
}

function row(key: string, displayName: string): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    boardFace: "dashboard",
    displayName,
    updatedAt: 1,
  };
}

function routeData(sessionRow: GatewaySessionRow): DashboardsRouteData {
  return {
    result: result(sessionRow),
    error: null,
    basePath: "",
    fallbackAgentId: "main",
    mainKey: "main",
  };
}

function connectedContext(
  request: (method: string, params: unknown) => Promise<unknown>,
  methods: string[] = ["board.get"],
  events?: {
    listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0];
    snapshotListener?: Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
  },
): ApplicationContext {
  return {
    basePath: "",
    gateway: {
      snapshot: {
        client: { request },
        phase: "connected",
        hello: { features: { methods } },
      },
      subscribe: (listener: Parameters<ApplicationContext["gateway"]["subscribe"]>[0]) => {
        if (events) {
          events.snapshotListener = listener;
        }
        return () => {
          if (events?.snapshotListener === listener) {
            events.snapshotListener = undefined;
          }
        };
      },
      subscribeEvents: (
        listener: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0],
      ) => {
        if (events) {
          events.listener = listener;
        }
        return () => {
          if (events?.listener === listener) {
            events.listener = undefined;
          }
        };
      },
    },
    sessions: {
      listSnapshot: () => ({ result: null, agentId: null, loading: false, error: null }),
      subscribeList: () => () => undefined,
      refreshList: vi.fn(async () => undefined),
    },
    agentSelection: {
      state: { selectedId: "main", scopeId: null },
      subscribe: () => () => undefined,
    },
    agents: { state: { agentsList: null } },
  } as unknown as ApplicationContext;
}

function mountPage(context: ApplicationContext, data: DashboardsRouteData): DashboardsPageElement {
  const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
  element.routeData = data;
  const provider = createApplicationContextProvider(context);
  provider.append(element);
  document.body.append(provider);
  return element;
}

describe("DashboardsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("subscribes to the exact query and preserves rows while a new agent scope loads", async () => {
    const selectionListeners = new Set<() => void>();
    const listListeners = new Map<string, (snapshot: SessionListSnapshot) => void>();
    const snapshots = new Map<string, SessionListSnapshot>();
    const queryKey = (options: SessionListOptions) => options.agentId ?? "all";
    const allResult = result(row("agent:main:before", "Before"));
    snapshots.set("all", { result: allResult, agentId: null, loading: false, error: null });
    snapshots.set("writer", { result: null, agentId: null, loading: false, error: null });
    const refreshList = vi.fn(async () => undefined);
    const subscribeList = vi.fn(
      (query: SessionListOptions, listener: (snapshot: SessionListSnapshot) => void) => {
        const key = queryKey(query);
        listListeners.set(key, listener);
        return () => listListeners.delete(key);
      },
    );
    const selectionState = { selectedId: "main", scopeId: null as string | null };
    const context = {
      basePath: "",
      gateway: {
        snapshot: { client: {}, phase: "connected", hello: null },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
      sessions: {
        listSnapshot(query: SessionListOptions) {
          return snapshots.get(queryKey(query))!;
        },
        subscribeList,
        refreshList,
      },
      agentSelection: {
        state: selectionState,
        subscribe(listener: () => void) {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const element = mountPage(context, routeData(row("agent:main:before", "Before")));
    await element.updateComplete;

    expect(subscribeList).toHaveBeenCalledWith(
      { limit: SIDEBAR_SESSION_ROSTER_LIMIT, hasBoard: true, archivedFilter: "all" },
      expect.any(Function),
    );
    expect(refreshList).not.toHaveBeenCalled();
    const retiredListener = listListeners.get("all")!;

    selectionState.scopeId = "writer";
    selectionListeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledTimes(1));
    expect(refreshList).toHaveBeenCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      hasBoard: true,
      archivedFilter: "all",
      agentId: "writer",
      force: true,
    });
    expect(element.textContent).toContain("Before");

    listListeners.get("writer")?.({
      result: result(row("agent:writer:current", "Writer dashboard")),
      agentId: "writer",
      loading: false,
      error: null,
    });
    await vi.waitFor(() => expect(element.textContent).toContain("Writer dashboard"));
    retiredListener({
      result: result(row("agent:main:retired", "Retired")),
      agentId: null,
      loading: false,
      error: "Retired scope refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Retired");

    const writerListener = listListeners.get("writer")!;
    writerListener({
      result: result(row("agent:writer:current", "Writer dashboard")),
      agentId: "writer",
      loading: false,
      error: "Writer refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).toContain("Writer dashboard");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("Writer refresh failed");
    refreshList.mockClear();
    element.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    expect(refreshList).toHaveBeenCalledOnce();
    expect(refreshList).toHaveBeenLastCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      hasBoard: true,
      archivedFilter: "all",
      agentId: "writer",
      force: true,
    });

    element.remove();
    writerListener({
      result: null,
      agentId: "writer",
      loading: false,
      error: "Detached refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Detached refresh failed");
  });

  it("loads every dashboard page so older dashboards remain searchable", async () => {
    const first = {
      ...results([row("agent:main:new", "New dashboard")]),
      totalCount: 2,
      hasMore: true,
      nextOffset: 1,
      offset: 0,
    };
    const second = {
      ...results([row("agent:main:old", "Old dashboard")]),
      totalCount: 2,
      hasMore: false,
      nextOffset: null,
      offset: 1,
    };
    const snapshot = { result: first, agentId: null, loading: false, error: null };
    const list = vi.fn(async () => second);
    const context = {
      basePath: "",
      gateway: {
        snapshot: { client: {}, phase: "connected", hello: null },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
      sessions: {
        list,
        listSnapshot: () => snapshot,
        subscribeList: () => () => undefined,
        refreshList: vi.fn(async () => undefined),
      },
      agentSelection: {
        state: { selectedId: "main", scopeId: null },
        subscribe: () => () => undefined,
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const element = mountPage(context, {
      result: first,
      error: null,
      basePath: "",
      fallbackAgentId: "main",
      mainKey: "main",
    });

    await vi.waitFor(() =>
      expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(2),
    );
    expect(list).toHaveBeenCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      hasBoard: true,
      archivedFilter: "all",
      offset: 1,
    });

    const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "old";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("Old dashboard");
  });

  it("filters by search and author and sorts visible cards by title", async () => {
    const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = {
      result: results([
        {
          ...row("agent:main:dashboard:zulu", "Zulu monitor"),
          updatedAt: 30,
          createdActor: { type: "human", id: "peter", label: "Peter" },
        },
        {
          ...row("agent:main:dashboard:alpha", "Alpha signals"),
          updatedAt: 10,
          createdActor: { type: "human", id: "mira", label: "Mira" },
        },
        {
          ...row("agent:main:dashboard:bravo", "Bravo health"),
          updatedAt: 20,
          createdActor: { type: "human", id: "peter", label: "Peter" },
        },
      ]),
      error: null,
      basePath: "",
      fallbackAgentId: "main",
      mainKey: "main",
    };
    document.body.append(element);
    await element.updateComplete;

    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(3);

    const search = element.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    if (!search) {
      return;
    }
    search.value = "signals";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("Alpha signals");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    const selects = element.querySelectorAll<HTMLSelectElement>("select");
    const authorSelect = selects.item(0);
    const sortSelect = selects.item(1);
    authorSelect.value = "mira";
    authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("By Mira");

    authorSelect.value = "";
    authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
    sortSelect.value = "title";
    sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(
      Array.from(element.querySelectorAll(".dashboard-card__heading h2"), (heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Alpha signals", "Bravo health", "Zulu monitor"]);
  });

  it("remembers the list view per browser", async () => {
    const context = connectedContext(async () => null, []);
    const element = mountPage(context, routeData(row("agent:main:dashboard:one", "One")));
    await element.updateComplete;
    expect(element.querySelector(".dashboard-card")).not.toBeNull();

    element.querySelector<HTMLButtonElement>('[data-dashboards-view="list"]')?.click();
    await element.updateComplete;
    expect(element.querySelector(".dashboard-row")).not.toBeNull();
    expect(element.querySelector(".dashboard-card")).toBeNull();
    expect(localStorage.getItem("openclaw:dashboards:view")).toBe("list");

    element.remove();
    const revisited = mountPage(context, routeData(row("agent:main:dashboard:one", "One")));
    await revisited.updateComplete;
    expect(revisited.querySelector(".dashboard-row")).not.toBeNull();
    expect(
      revisited.querySelector('[data-dashboards-view="list"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("fetches each dashboard board once and reuses it across view changes", async () => {
    const board = {
      sessionKey: "agent:main:dashboard:one",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
      widgets: [
        {
          name: "hero",
          tabId: "main",
          title: "Hero",
          contentKind: "html",
          sizeW: 12,
          sizeH: 3,
          position: 0,
          grantState: "none",
          revision: 1,
        },
      ],
    };
    const request = vi.fn(async () => board);
    const context = connectedContext(request);
    const element = mountPage(context, {
      ...routeData({ ...row("agent:main:dashboard:one", "One"), agentId: "main" }),
    });

    await vi.waitFor(() => expect(element.querySelectorAll("svg g")).toHaveLength(1));
    expect(request).toHaveBeenCalledWith("board.get", {
      sessionKey: "agent:main:dashboard:one",
      agentId: "main",
      prepareViews: false,
    });

    element.querySelector<HTMLButtonElement>('[data-dashboards-view="list"]')?.click();
    await element.updateComplete;
    await vi.waitFor(() =>
      expect(element.querySelectorAll(".dashboard-row svg g")).toHaveLength(1),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a transient preview failure instead of caching it", async () => {
    const board = {
      sessionKey: "agent:main:dashboard:one",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
      widgets: [
        {
          name: "recovered",
          tabId: "main",
          title: "Recovered",
          contentKind: "html",
          sizeW: 12,
          sizeH: 3,
          position: 0,
          grantState: "none",
          revision: 1,
        },
      ],
    };
    const request = vi
      .fn<(method: string, params: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValue(board);
    const element = mountPage(
      connectedContext(request),
      routeData(row("agent:main:dashboard:one", "One")),
    );

    await vi.waitFor(() => expect(element.textContent).toContain("Preview unavailable"));
    element.querySelector<HTMLButtonElement>('[data-dashboards-view="list"]')?.click();
    await vi.waitFor(() => expect(element.textContent).toContain("Recovered"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("clears preview snapshots across a same-client reconnect", async () => {
    const firstWidget = {
      name: "status",
      tabId: "main",
      title: "Before reconnect",
      contentKind: "html",
      sizeW: 12,
      sizeH: 3,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const firstBoard = {
      sessionKey: "agent:main:dashboard:one",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
      widgets: [firstWidget],
    };
    const secondBoard = {
      ...firstBoard,
      revision: 2,
      widgets: [{ ...firstWidget, title: "After reconnect", revision: 2 }],
    };
    let currentBoard = firstBoard;
    const request = vi.fn(async () => currentBoard);
    const events: {
      snapshotListener?: Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    } = {};
    const context = connectedContext(request, ["board.get"], events);
    const element = mountPage(context, routeData(row("agent:main:dashboard:one", "One")));

    await vi.waitFor(() => expect(element.textContent).toContain("Before reconnect"));
    currentBoard = secondBoard;
    context.gateway.snapshot.phase = "reconnecting";
    context.gateway.snapshot.hello = null;
    events.snapshotListener?.(context.gateway.snapshot);
    context.gateway.snapshot.phase = "connected";
    context.gateway.snapshot.hello = { features: { methods: ["board.get"] } } as never;
    events.snapshotListener?.(context.gateway.snapshot);
    await vi.waitFor(() => expect(element.textContent).toContain("After reconnect"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes a global board preview from its observer-scoped board.changed event", async () => {
    const events: {
      listener?: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0];
      snapshotListener?: Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    } = {};
    const firstWidget = {
      name: "status",
      tabId: "main",
      title: "Old layout",
      contentKind: "html",
      sizeW: 12,
      sizeH: 3,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const firstBoard = {
      sessionKey: "agent:work:global",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
      widgets: [firstWidget],
    };
    const secondBoard = {
      ...firstBoard,
      revision: 2,
      widgets: [{ ...firstWidget, title: "Fresh layout", revision: 2 }],
    };
    const request = vi.fn().mockResolvedValueOnce(firstBoard).mockResolvedValue(secondBoard);
    const element = mountPage(
      connectedContext(request, ["board.get"], events),
      routeData({ ...row("global", "Global"), agentId: "work" }),
    );

    await vi.waitFor(() => expect(element.textContent).toContain("Old layout"));
    events.listener?.({
      type: "event",
      event: "board.changed",
      payload: { sessionKey: "agent:work:global", revision: 2 },
    });
    await vi.waitFor(() => expect(element.textContent).toContain("Fresh layout"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falls back to a placeholder when the gateway does not serve boards", async () => {
    const request = vi.fn(async () => null);
    const context = connectedContext(request, ["sessions.list"]);
    const element = mountPage(context, routeData(row("agent:main:dashboard:one", "One")));

    await vi.waitFor(() => expect(element.textContent).toContain("Preview unavailable"));
    expect(request).not.toHaveBeenCalled();
  });
});
