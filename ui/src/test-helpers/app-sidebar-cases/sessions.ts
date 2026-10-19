import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SidebarSessionSortMode } from "../../components/app-sidebar-session-types.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  createSessionState,
  mountSidebar,
  type SidebarLifecycleState,
  type TestSessionMenu,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { settleLitElement } from "../lit-settle.ts";
import "./session-pagination.ts";
import "./session-navigation.ts";

type SidebarSortModeHost = {
  sessionSortMode: SidebarSessionSortMode;
  setSessionSortMode: (mode: SidebarSessionSortMode) => void;
};

function required<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("Expected fixture value");
  }
  return value;
}

function expectCleared(sidebar: SidebarLifecycleState) {
  expect(sidebar.sessionData).toMatchObject({
    sessionsResult: null,
    sessionsAgentId: null,
    sessionResultsByAgent: {},
  });
  expect(sidebar.sessionData.sessionResultsByAgent).toEqual({});
}

async function mountRow(key: string, patch: Partial<GatewaySessionRow>) {
  const sessions = createSessionsHarness("main", [key]);
  const state = createSessionState("main", [key]);
  Object.assign(required(state.result?.sessions[0]), patch);
  sessions.publishList({ result: state.result, agentId: state.agentId });
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    sessions.sessions,
  );
  sidebar.connected = true;
  await sidebar.updateComplete;
  required(sidebar.querySelector(`[data-session-key="${key}"]`)).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
  await sidebar.updateComplete;
  const menu = required(sidebar.querySelector<TestSessionMenu>("openclaw-session-menu"));
  await menu.updateComplete;
  return { sidebar, sessions, menu };
}

function expectAttributes(
  element: Element | null | undefined,
  attributes: Record<string, string | null>,
) {
  for (const [name, value] of Object.entries(attributes)) {
    expect(required(element).getAttribute(name), name).toBe(value);
  }
}

describe("AppSidebar session sort persistence", () => {
  it("restores the selected sort mode on a later mount", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const first = await mountSidebar(gateway, createSessions("main", ["agent:main:session-a"]));
    const firstSidebar = first.sidebar as unknown as SidebarSortModeHost;
    expect(firstSidebar.sessionSortMode).toBe("created");

    firstSidebar.setSessionSortMode("updated");
    expect(localStorage.getItem("openclaw:sidebar:sessions:sort-mode")).toBe("updated");

    document.body.replaceChildren();
    const second = await mountSidebar(gateway, createSessions("main", ["agent:main:session-a"]));

    expect((second.sidebar as unknown as SidebarSortModeHost).sessionSortMode).toBe("updated");
  });
});

describe("AppSidebar session pagination", () => {
  it("does not show pagination controls at the ten-session boundary", async () => {
    const keys = [
      "agent:main:session-0",
      ...Array.from({ length: 9 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", keys));

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(10);
    expect(sidebar.querySelector(".sidebar-session-pagination")).toBeNull();
  });

  it("keeps visible sessions when a newer session enters the created-sort page", async () => {
    const olderKeys = Array.from({ length: 10 }, (_, index) => `agent:main:older-${index}`);
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", olderKeys);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    const refreshed = createSessionState("main", [...olderKeys, "agent:main:external-new"]);
    required(refreshed.result?.sessions.at(-1)).createdAt = 2_000;

    sessions.publishList({ result: refreshed.result, agentId: refreshed.agentId });
    await settleLitElement(sidebar);

    expect(
      Array.from(
        sidebar.querySelectorAll<HTMLElement>("[data-session-key]"),
        (row) => row.dataset.sessionKey,
      ),
    ).toEqual(["agent:main:external-new", ...olderKeys]);
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(11);
    expect(sidebar.querySelector('button[aria-label="Show more"]')).toBeNull();
  });

  it("reveals sessions ten at a time and offers Collapse after thirty", async () => {
    const keys = Array.from({ length: 41 }, (_, index) => `agent:main:session-${index}`);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", keys));
    const rows = () => sidebar.querySelectorAll(".sidebar-recent-session");
    const button = (label: string) =>
      sidebar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(rows()).toHaveLength(10);
    expect(button("Show more")).not.toBeNull();
    expect(button("Collapse")).toBeNull();

    for (const count of [20, 30, 40, 41]) {
      button("Show more")?.click();
      await settleLitElement(sidebar);
      expect(rows()).toHaveLength(count);
      expect(button("Collapse") !== null).toBe(count >= 40);
      if (count >= 40) {
        expect(button("Show more") !== null).toBe(count < 41);
      }
    }

    button("Collapse")?.click();
    await settleLitElement(sidebar);
    expect(rows()).toHaveLength(10);
    expect(button("Show more")).not.toBeNull();
    expect(button("Collapse")).toBeNull();
  });
});

async function createReconnectFixture(initial: ReturnType<typeof createSessionState>) {
  const reconnectList = createDeferred<SessionsListResult>();
  let firstList = true;
  const request = (method: string) => {
    if (method === "sessions.list") {
      if (firstList) {
        firstList = false;
        return initial.result;
      }
      return reconnectList.promise;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.groups.list") {
      return { names: [], groups: [], sectionOrder: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  };
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createSessionCapability(gateway.gateway, {
    state: { selectedId: "main" },
    subscribe: () => () => undefined,
  });
  onTestFinished(() => sessions.dispose());
  await sessions.refresh({ agentId: "main" });
  return { gateway, sessions, reconnectList, replacementClient: createTestGatewayClient(request) };
}

describe("AppSidebar session source lifecycle", () => {
  it("disables Fork session for model-selection-locked rows", async () => {
    const { menu } = await mountRow("agent:main:locked", { modelSelectionLocked: true });
    expect(menu.forkDisabled).toBe(true);
    expect(menu.querySelector<HTMLButtonElement>('[data-shortcut="f"]')?.disabled).toBe(true);
  });

  it("forks from stable history when Gateway liveness outlives display status", async () => {
    const { sessions, menu } = await mountRow("agent:main:active", {
      status: "done",
      hasActiveRun: true,
    });
    expect(menu.forkFromLastCompleted).toBe(true);
    menu.onAction({ kind: "fork" });
    await vi.dynamicImportSettled();

    expect(sessions.create).toHaveBeenCalledWith(
      {
        parentSessionKey: "agent:main:active",
        fork: true,
        forkFrom: "last-completed",
        agentId: "main",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("resets per-agent cached results when the sessions source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGateway(client);
    const { provider, sidebar } = await mountSidebar(
      gateway,
      createSessions("first", ["first-a", "first-b"]),
    );

    expect(Object.keys(sidebar.sessionData.sessionResultsByAgent)).toEqual(["first"]);

    // The Gateway and its client stay unchanged while the sessions capability is replaced.
    provider.setContext(createContext(gateway, createSessions("second", ["second-b", "second-a"])));
    await sidebar.updateComplete;

    expect(Object.keys(sidebar.sessionData.sessionResultsByAgent)).toEqual(["second"]);
    expect(sidebar.sessionData.sessionsAgentId).toBe("second");
    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "second-b",
      "second-a",
    ]);
  });

  it("preserves the scoped result through a disconnect on the same Gateway client", async () => {
    const initial = createSessionState("main", ["main-a", "main-b"]);
    required(initial.result).owners = [{ type: "human", id: "profile-ada", label: "Ada" }];
    const { gateway, sessions, reconnectList } = await createReconnectFixture(initial);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions);
    const cachedResult = sidebar.sessionData.sessionsResult;

    gateway.publish({ phase: "reconnecting" });
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionData.sessionsAgentId).toBe("main");
    expect(Object.keys(sidebar.sessionData.sessionResultsByAgent)).toEqual(["main"]);
    expect(sidebar.sessionData.sessionResultsByAgent.main?.owners).toEqual([
      { type: "human", id: "profile-ada", label: "Ada" },
    ]);

    gateway.publish({ phase: "connected" });
    const partial = createSessionState("main", ["main-a"]);
    sessions.reconcile(partial.result?.sessions[0]);
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "main-a",
      "main-b",
    ]);
    expect(sidebar.sessionData.sessionResultsByAgent.main?.sessions.map((row) => row.key)).toEqual([
      "main-a",
      "main-b",
    ]);

    const refreshed = createSessionState("main", ["main-c"]);
    reconnectList.resolve(required(refreshed.result));
    await vi.waitFor(() => expect(sessions.canonicalListRevision).toBe(2));
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual(["main-c"]);
    expect(sidebar.sessionData.sessionsAgentId).toBe("main");
  });

  it("retires protected session views on client replacement without removing personal pins", async () => {
    const key = "agent:main:pinned";
    const initial = createSessionState("main", [key]);
    Object.assign(required(initial.result?.sessions[0]), { pinned: true, pinnedAt: 1 });
    const { gateway, sessions, reconnectList, replacementClient } =
      await createReconnectFixture(initial);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions);
    sidebar.sidebarEntries = [`session:${key}`];
    await sidebar.updateComplete;
    const pinnedEntry = () =>
      sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="session:${key}"] a`);

    expect(pinnedEntry()).not.toBeNull();

    gateway.publish({
      client: replacementClient,
      phase: "reconnecting",
    });
    await sidebar.updateComplete;

    expectCleared(sidebar);
    expect(pinnedEntry()).toBeNull();
    expect(sidebar.sidebarEntries).toEqual([`session:${key}`]);

    gateway.publish({ phase: "connected" });
    const unpinned = createSessionState("main", [key]);
    sessions.reconcile(unpinned.result?.sessions[0]);
    await sidebar.updateComplete;
    expect(pinnedEntry()).toBeNull();

    reconnectList.resolve(required(unpinned.result));
    await vi.waitFor(() => expect(sessions.canonicalListRevision).toBe(2));
    await sidebar.updateComplete;
    expect(pinnedEntry()).not.toBeNull();
    expect(sidebar.sidebarEntries).toEqual([`session:${key}`]);
    sidebar.onUpdateSidebarEntries = (entries) => {
      sidebar.sidebarEntries = entries;
    };
    await sidebar.sidebarMenus.preloadMenuRenderer();
    pinnedEntry()!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-rail-pin-menu")!;
    menu.querySelector<HTMLElement>('[data-value="remove"]')!.click();
    await sidebar.updateComplete;
    expect(pinnedEntry()).toBeNull();
    expect(sidebar.sidebarEntries).toEqual([]);
  });

  it("clears cached session views when the Gateway connection changes", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    Object.defineProperty(gateway.gateway, "connection", {
      configurable: true,
      value: { ...gateway.gateway.connection, gatewayUrl: "ws://replacement.test" },
    });
    Object.defineProperty(gateway.gateway, "connectionRevision", {
      configurable: true,
      value: 1,
    });

    gateway.publish({ client: {} as GatewayBrowserClient, phase: "reconnecting" });
    await sidebar.updateComplete;

    expectCleared(sidebar);
  });

  it("clears every cached session view when the Gateway source is replaced", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { provider, sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    const replacementGateway = createGatewayHarness(client);
    provider.setContext(createContext(replacementGateway.gateway, sessions.sessions));
    await sidebar.updateComplete;

    expectCleared(sidebar);
  });
});

describe("AppSidebar session accessibility", () => {
  it("exposes a derived title through native list and link semantics", async () => {
    const key = "agent:main:dashboard:opaque-id";
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [key]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = key;
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key,
            kind: "direct",
            label: key,
            displayName: key,
            derivedTitle: "Quarterly launch plan",
            updatedAt: Date.now(),
            unread: true,
          },
        ],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    const list = sidebar.querySelector('[data-session-section="ungrouped"] [role="list"]');
    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    const tree = row?.closest(".sidebar-session-tree");
    const link = row?.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link");
    expectAttributes(list, { "aria-label": "Other" });
    expect(tree?.parentElement).toBe(list);
    expectAttributes(tree, { role: "listitem" });
    expectAttributes(row, { role: null, "aria-label": null });
    expectAttributes(sidebar.querySelector(".sidebar-recent-sessions"), { "aria-label": null });
    expectAttributes(link, {
      "aria-label": null,
      "aria-current": "page",
      title: null,
      "aria-describedby": null,
    });
    const lead = link?.querySelector(".sidebar-session-indicator");
    expect(lead).not.toBeNull();
    expect(lead?.childElementCount).toBe(1);
    expect(link?.querySelector(".sidebar-recent-session__text")).not.toBeNull();
    const unread = lead?.querySelector(".session-unread-dot");
    expectAttributes(unread, { role: "img", "aria-label": "Unread" });
    expect(row?.querySelector(".session-row-state")).toBeNull();
    expect(link?.querySelector(".sidebar-recent-session__name")?.textContent).toBe(
      "Quarterly launch plan",
    );
    expect(row?.querySelector(".session-row-trail")).toBeNull();
  });
});

describe("AppSidebar session navigation", () => {
  it("selects a literal session's agent before changing the active session", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:research:work"]),
      "panel",
      TWO_AGENTS,
    );
    const calls: string[] = [];
    context.agentSelection.set = vi.fn((agentId) => calls.push(`agent:${agentId}`));
    gateway.setSessionKey = vi.fn((sessionKey) => calls.push(`session:${sessionKey}`));

    (sidebar as unknown as { selectSession: (sessionKey: string) => void }).selectSession(
      "agent:research:work",
    );

    expect(calls).toEqual(["agent:research", "session:agent:research:work"]);
  });
});
