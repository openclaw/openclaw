/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { makeBootRoster } from "../app/bootstrap.test-support.ts";
import { createChatSubmissions } from "../app/chat-submissions.ts";
import type { ApplicationOverlaySnapshot } from "../app/overlays-types.ts";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { admitSidebarBootScope } from "../pages/chat/session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  catalogPage,
  createContext,
  createGatewayHarness,
  createSidebarElement,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import * as sidebarAgentSessionRows from "./app-sidebar-agent-session-rows.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import * as sessionLeadingIndicator from "./session-leading-indicator.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";
import { snapshotSessions } from "./sidebar-snapshot-model.ts";

type Sidebar = AppSidebarSessionNavigationElement & HTMLElement;

const key = (name: string) => `agent:main:${name}`;
const ada = { type: "human" as const, id: "ada", label: "Ada" };
const bob = { type: "human" as const, id: "bob", label: "Bob" };
let projectRows: MockInstance<typeof sidebarAgentSessionRows.projectSidebarAgentSessionRows>;

beforeEach(() => {
  projectRows = vi.spyOn(sidebarAgentSessionRows, "projectSidebarAgentSessionRows");
});

function session(name: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: key(name),
    sessionId: `session-${name}`,
    kind: "direct",
    label: name,
    updatedAt: 1,
    createdAt: 1,
    owner: { actor: ada },
    ...fields,
  };
}

async function mount(rows: GatewaySessionRow[]) {
  const sessions = createSessionsHarness("main", []);
  sessions.publishList({
    result: {
      ...sessions.sessions.state.result!,
      sessions: rows,
      count: rows.length,
      owners: [ada, bob],
    },
  });
  const gateway = createGatewayHarness(
    createTestGatewayClient(vi.fn(async () => ({ questions: [] }))),
  );
  const context = {
    ...createContext(
      gateway.gateway,
      sessions.sessions,
      makeBootRoster({
        agents: [{ id: "main" }, { id: "work" }],
      }),
    ),
    chatSubmissions: createChatSubmissions(),
  };
  const overlayListeners = new Set<(snapshot: ApplicationOverlaySnapshot) => void>();
  context.overlays.subscribe = (listener) => {
    overlayListeners.add(listener);
    return () => overlayListeners.delete(listener);
  };
  const mounted = await mountSidebarContext(context);
  const sidebar = mounted.sidebar as unknown as Sidebar;
  sidebar.sidebarAgentsMode = "chip";
  await settleLitElement(sidebar);
  const row = (sessionKey: string) => sidebar.querySelector(`[data-session-key="${sessionKey}"]`);
  const publish = (next: GatewaySessionRow[]) =>
    sessions.publishList({
      result: {
        ...sessions.sessions.state.result!,
        sessions: next,
        count: next.length,
        owners: structuredClone(sessions.sessions.state.result!.owners),
      },
    });
  return {
    ...mounted,
    sidebar,
    sessions,
    gateway,
    row,
    publish,
    publishApprovals: (approvalQueue: ApplicationOverlaySnapshot["approvalQueue"]) => {
      context.overlays.snapshot.approvalQueue = approvalQueue;
      for (const listener of overlayListeners) {
        listener(context.overlays.snapshot);
      }
    },
  };
}

async function update(sidebar: Sidebar, change: (() => void) | Partial<Sidebar>) {
  if (typeof change === "function") {
    change();
  } else {
    Object.assign(sidebar, change);
  }
  if (vi.isFakeTimers()) {
    vi.advanceTimersToNextFrame();
  }
  await settleLitElement(sidebar);
}

describe("sidebar projection memo", () => {
  it("reuses a held roster without enumerating it for each navigation read", async () => {
    const first = session("first");
    const { sidebar } = await mount([first]);
    const result = sidebar.sessionData.sessionsResult!;
    const enumerate = vi.fn(Reflect.ownKeys);
    sidebar.sessionData.sessionResultsByAgent = new Proxy<Record<string, SessionsListResult>>(
      { main: result },
      { ownKeys: enumerate },
    );
    const navigation = sidebar.getSessionNavigationState();
    enumerate.mockClear();

    expect(sidebar.findSidebarSessionByKey(first.key)?.label).toBe("first");
    expect(sidebar.getSessionNavigationState()).toBe(navigation);
    expect(sidebar.findSidebarSessionByKey(first.key)?.label).toBe("first");
    expect(enumerate).not.toHaveBeenCalled();

    const added = session("added", { key: "agent:work:added", agentId: "work" });
    sidebar.sessionData.sessionResultsByAgent = new Proxy<Record<string, SessionsListResult>>(
      { main: result, work: { ...result, sessions: [added], count: 1 } },
      { ownKeys: enumerate },
    );
    const replacement = sidebar.getSessionNavigationState();
    expect(replacement).not.toBe(navigation);
    expect(sidebar.findSidebarSessionByKey(added.key)?.label).toBe("added");
    expect(sidebar.sessionProjection.createdOrder.has(added.key)).toBe(true);
    enumerate.mockClear();
    expect(sidebar.getSessionNavigationState()).toBe(replacement);
    expect(sidebar.findSidebarSessionByKey(first.key)?.label).toBe("first");
    expect(enumerate).not.toHaveBeenCalled();
  });

  it.each([10, 30])("keeps newer pagination at %s rows through cached handoff", async (limit) => {
    const sessionsToShow = Array.from({ length: 40 }, (_, index) => session(`row-${index}`));
    const { sidebar, sessions } = await mount(sessionsToShow);
    const owner = getAppSidebarOwner(sidebar.hostElement)!;
    const sectionId = "ungrouped";
    expect(
      sidebar.querySelector("[data-session-section]")?.getAttribute("data-session-section"),
    ).toBe(sectionId);
    vi.spyOn(owner, "sidebarSnapshotSettled").mockReturnValue(false);
    const rows = snapshotSessions(
      sessionsToShow.map((row) => sidebar.getSessionNavigationState().toSidebarSession(row)),
    );
    owner.restoreSidebarSnapshot({
      ...sidebarBootSnapshot(captureBootRoster(sessions.sessions.state)),
      mode: "chip",
      sessions: rows,
      entries: [],
      sections: [
        {
          id: sectionId,
          rows: rows.slice(0, 20),
          totalRowCount: rows.length,
          visibleRowCount: 20,
          visibleLimit: 20,
          collapsedVisibleRowCount: 10,
          renderHeader: false,
        },
      ],
    });
    owner.invalidate();
    await settleLitElement(sidebar);
    owner.setVisibleSessionLimit(sectionId, limit);
    owner.releaseSidebarSnapshot();
    owner.invalidate();
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
    ).toHaveLength(limit);
  });

  it("prepares initially hidden session rows from shell inputs while keeping later owner updates parked", async () => {
    const target = session("question-proof");
    const sessions = createSessionsHarness("main", []);
    const client = createTestGatewayClient(vi.fn(async () => ({ questions: [] })));
    const gateway = createGatewayHarness(client);
    gateway.publish({ phase: "connecting", client: null, hello: null });
    const context = createContext(gateway.gateway, sessions.sessions);
    const provider = createApplicationContextProvider(context);
    const sidebar = await createSidebarElement();
    sidebar.navigationVisible = false;
    sidebar.connected = false;
    sidebar.activeRouteId = "chat";
    provider.append(sidebar.hostElement);
    document.body.append(provider);
    onTestFinished(() => provider.remove());
    await settleLitElement(sidebar);
    const row = () => sidebar.querySelector(`[data-session-key="${target.key}"]`);
    expect(row()).toBeNull();

    sessions.publishList({
      result: { ...sessions.sessions.state.result!, sessions: [target], count: 1 },
    });
    gateway.publish({ phase: "connected", client, hello: gatewayHelloForMethods([]) });
    sidebar.connected = true;
    const gatewayStatus = {
      kind: "connected" as const,
      lastError: null,
      queuedCount: 0,
      onRetry: vi.fn(),
    };
    sidebar.gatewayStatus = gatewayStatus;
    sidebar.sessionKey = target.key;
    await waitForSolid(() => expect(row()?.textContent).toContain("question-proof"));
    expect(sidebar.navigationVisible).toBe(false);
    const heldRow = row();
    const reads = sessions.list.mock.calls.length;
    const created = session("created-while-hidden");
    const createdRow = () => sidebar.querySelector(`[data-session-key="${created.key}"]`);

    sessions.publishList({
      result: {
        ...sessions.sessions.state.result!,
        sessions: [{ ...target, label: "Updated while hidden" }, created],
        count: 2,
      },
    });
    await settleLitElement(sidebar);
    expect(createdRow()).toBeNull();

    // Shell commits recreate status even when the connection has not changed.
    sidebar.gatewayStatus = { ...gatewayStatus };
    await settleLitElement(sidebar);
    expect(createdRow()).toBeNull();
    expect(row()).toBe(heldRow);
    expect(row()?.textContent).toContain("question-proof");
    expect(row()?.textContent).not.toContain("Updated while hidden");
    expect(sessions.list).toHaveBeenCalledTimes(reads);
    sidebar.navigationVisible = true;
    await waitForSolid(() => {
      expect(row()?.textContent).toContain("Updated while hidden");
      expect(createdRow()?.textContent).toContain("created-while-hidden");
    });
  });

  it("keeps a pending boot read across connected view recreation and retires it on detach", async () => {
    const pending = createDeferred<SidebarSnapshotModel | null>();
    const read = vi
      .spyOn(SessionSnapshotStore.prototype, "readSidebar")
      .mockReturnValue(pending.promise);
    const sessions = createSessionsHarness("main", [key("cached")]);
    const gateway = createGatewayHarness(
      createTestGatewayClient(vi.fn(async () => ({ questions: [] }))),
    );
    gateway.publish({ phase: "connecting", client: null, hello: null });
    const context = createContext(gateway.gateway, sessions.sessions, makeBootRoster());
    onTestFinished(
      admitSidebarBootScope(gateway.gateway, {
        scope: gateway.gateway.connection.gatewayUrl,
        recoveryScope: "synthetic-account",
        profileId: null,
      }),
    );
    const { sidebar, provider } = await mountSidebarContext(context);
    const host = sidebar.hostElement;
    const owner = getAppSidebarOwner(host);
    expect(host.querySelector("aside.sidebar")).toBeNull();
    provider.setContext({ ...context });
    await settleLitElement(sidebar);
    expect(getAppSidebarOwner(host)).toBe(owner);
    expect(host.querySelector("aside.sidebar")).toBeNull();
    pending.resolve({
      ...sidebarBootSnapshot(captureBootRoster(sessions.sessions.state)),
      mode: "chip",
    });
    await waitForSolid(() =>
      expect(host.querySelector("aside.sidebar")?.getAttribute("data-snapshot-state")).toBe(
        "cached",
      ),
    );
    expect(read).toHaveBeenCalledOnce();
    host.remove();
    await settleLitElement(sidebar);
    provider.append(host);
    await waitForSolid(() =>
      expect(host.querySelector("aside.sidebar")?.getAttribute("data-snapshot-state")).toBe("live"),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps one provisional row and invalidates admission without a new list or route", async () => {
    const old = session("old");
    const created = session("dashboard:creating");
    const { sidebar, context, gateway, publish, row } = await mount([old]);
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = created.key;
    gateway.publish({ sessionKey: old.key });
    const creation = { sessionKey: created.key, admitted: false };
    const release = context.chatSubmissions.beginCreate({
      creation,
      message: null,
      canDisplay: () => true,
    });
    try {
      await settleLitElement(sidebar);
      expect(sidebar.getRouteSessionKey()).toBe(created.key);
      expect(sidebar.findSidebarSessionByKey(old.key)?.visuallyActive).toBe(false);
      expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(1);
      publish([old, created]);
      await settleLitElement(sidebar);
      expect(row(created.key)).toBeNull();
      expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(1);
      const result = sidebar.sessionData.sessionsResult;
      const navigation = sidebar.getSessionNavigationState();
      expect(result?.sessions.some((value) => value.key === created.key)).toBe(true);
      creation.admitted = true;
      sidebar.invalidate();
      await settleLitElement(sidebar);
      expect(sidebar.sessionData.sessionsResult).toBe(result);
      expect(sidebar.getSessionNavigationState()).not.toBe(navigation);
      expect(sidebar.getRouteSessionKey()).toBe(created.key);
      expect(sidebar.findSidebarSessionByKey(created.key)?.visuallyActive).toBe(true);
      expect(row(created.key)).not.toBeNull();
      expect(sidebar.querySelectorAll(".sidebar-recent-session--creating")).toHaveLength(0);
    } finally {
      release();
    }
  });

  it("refreshes Home and route selection after accepted row changes", async () => {
    const home = session("main", { lastMessagePreview: "Home before" });
    const first = session("first");
    const second = session("second", { owner: { actor: bob } });
    const projectHome = vi.spyOn(sidebarAgentSessionRows, "projectSidebarHomeSession");
    const describeState = vi.spyOn(sessionLeadingIndicator, "describeSessionState");
    const { sidebar, row, publish } = await mount([home, first, second]);
    publish([
      { ...home, lastMessagePreview: "Home after" },
      { ...first, label: "Renamed first" },
      second,
    ]);
    await settleLitElement(sidebar);
    expect(row(first.key)?.textContent).toContain("Renamed first");
    expect(projectHome.mock.results.at(-1)?.value.lastMessagePreview).toBe("Home after");
    const firstRow = row(first.key);
    const secondRow = row(second.key);
    describeState.mockClear();
    await update(sidebar, { activeRouteId: "chat", sessionKey: first.key });
    expect(sidebar.findSidebarSessionByKey(first.key)?.visuallyActive).toBe(true);
    expect(row(first.key)?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
    await update(sidebar, { sessionKey: second.key });
    expect(sidebar.findSidebarSessionByKey(first.key)?.visuallyActive).toBe(false);
    expect(sidebar.findSidebarSessionByKey(second.key)?.visuallyActive).toBe(true);
    expect(row(first.key)).toBe(firstRow);
    expect(row(second.key)).toBe(secondRow);
    expect(firstRow?.querySelector("a")?.getAttribute("aria-current")).toBeNull();
    expect(secondRow?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
    expect(describeState).not.toHaveBeenCalled();
    publish([home, { ...first, hasActiveRun: true, unread: true }, second]);
    await settleLitElement(sidebar);
    expect(describeState).toHaveBeenCalled();
    expect(row(first.key)?.querySelector(".sr-only")?.textContent).toContain("Unread");
  });

  it.each([
    { statusFilter: "snoozed", adopted: false },
    { statusFilter: "active", adopted: true },
  ] as const)(
    "refreshes $statusFilter snooze visibility (adopted=$adopted)",
    async ({ statusFilter, adopted }) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const target = session(
        "adopted",
        adopted ? { key: "agent:work:adopted", agentId: "work" } : {},
      );
      const snoozed = { ...target, snoozedUntil: 11_000, snoozedAt: 9_000 };
      const { sidebar, sessions, row } = await mount(adopted ? [] : [snoozed]);
      sidebar.sessionsStatusFilter = statusFilter;
      if (adopted) {
        const cachedResult = { ...sessions.sessions.state.result!, sessions: [target], count: 1 };
        sidebar.sessionData.sessionResultsByAgent = { work: cachedResult };
        sidebar.sessionData.sessionCatalogs = catalogPage([
          { threadId: "adopted-thread", sessionKey: target.key, name: "Adopted catalog thread" },
        ]).catalogs;
        sidebar.invalidate();
        await settleLitElement(sidebar);
        expect(row(target.key)?.hasAttribute("data-catalog-session-key")).toBe(true);
        sidebar.sessionData.sessionResultsByAgent = {
          work: { ...cachedResult, sessions: [snoozed] },
        };
        sidebar.invalidate();
      }
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");
      sidebar.invalidate();
      await settleLitElement(sidebar);
      await vi.advanceTimersByTimeAsync(999);
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");
      await vi.advanceTimersByTimeAsync(2);
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "active");
      if (adopted) {
        expect(row(target.key)?.hasAttribute("data-catalog-session-key")).toBe(true);
        expect(row(target.key)?.textContent).toContain("adopted");
      }
    },
  );

  it("re-arms snoozed visibility for the next deadline without a new list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const first = session("first-wake", { snoozedUntil: 11_000, snoozedAt: 9_000 });
    const second = session("second-wake", { snoozedUntil: 12_000, snoozedAt: 9_000 });
    const { sidebar, row, sessions } = await mount([first, second]);
    sidebar.sessionsStatusFilter = "snoozed";
    await settleLitElement(sidebar);
    expect(row(first.key)).not.toBeNull();
    expect(row(second.key)).not.toBeNull();
    const reads = sessions.list.mock.calls.length;

    await vi.advanceTimersByTimeAsync(11_001 - Date.now());
    await settleLitElement(sidebar);
    expect(row(first.key)).toBeNull();
    expect(row(second.key)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(12_001 - Date.now());
    await settleLitElement(sidebar);
    expect(row(first.key)).toBeNull();
    expect(row(second.key)).toBeNull();
    expect(sessions.list).toHaveBeenCalledTimes(reads);
  });

  it("updates timed attention, questions, and approvals without replacing the row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const expiresAt = 11_000;
    const target = session("attention", {
      agentStatus: { note: "Waiting for credentials", attention: "key", expiresAt },
    });
    const { sidebar, gateway, row, publishApprovals } = await mount([target]);
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    projectRows.mockClear();
    // Mount readiness advances fake timers; stop before the expiry invalidation turn.
    await vi.advanceTimersByTimeAsync(expiresAt - Date.now());
    await settleLitElement(sidebar);
    expect(projectRows).not.toHaveBeenCalled();
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settleLitElement(sidebar);
    expect(projectRows).toHaveBeenCalled();
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).toBeNull();
    await update(sidebar, () =>
      gateway.publishEvent("question.requested", {
        id: "question-memo",
        sessionKey: target.key,
        agentId: "main",
        status: "pending",
        questions: [
          {
            questionId: "continue",
            header: "Continue",
            question: "Continue checking?",
            options: [],
          },
        ],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    expect(
      row(target.key)
        ?.querySelector('[data-session-attention="question"]')
        ?.getAttribute("aria-label"),
    ).toContain("Continue checking?");
    const parent = sidebar.hostElement.parentElement!;
    sidebar.hostElement.remove();
    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    expect(row(target.key)?.querySelector('[data-session-attention="question"]')).not.toBeNull();
    await update(sidebar, () =>
      gateway.publishEvent("question.resolved", { id: "question-memo", status: "cancelled" }),
    );
    expect(row(target.key)?.querySelector('[data-session-attention="question"]')).toBeNull();
    await update(sidebar, () =>
      publishApprovals([
        {
          id: "approval-memo",
          kind: "exec",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          request: { command: "git diff", sessionKey: target.key, agentId: "main" },
        },
      ]),
    );
    expect(
      row(target.key)
        ?.querySelector('[data-session-attention="approval"]')
        ?.getAttribute("aria-label"),
    ).toContain("git diff");
    await update(sidebar, () => publishApprovals([]));
    expect(row(target.key)?.querySelector('[data-session-attention="approval"]')).toBeNull();
  });

  it("replaces held running subtitles at their deadline after reparenting without a full row projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const target = session("running", {
      hasActiveRun: true,
      activeRunIds: ["run-memo"],
      status: "running",
    });
    const { sidebar, row, sessions, gateway } = await mount([target]);
    sidebar.sessionsShowPreview = true;
    sidebar.sidebarLiveActivity = true;
    sidebar.connected = true;
    await vi.waitFor(() => expect(sessions.subscribeMessages).toHaveBeenCalledOnce());
    const narrate = (text: string) =>
      gateway.publishEvent("session.narration", {
        sessionKey: target.key,
        runId: "run-memo",
        text,
      });
    narrate("First activity");
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    await vi.advanceTimersByTimeAsync(500);
    narrate("Second activity");
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    const parent = sidebar.hostElement.parentElement!;
    sidebar.hostElement.remove();
    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    narrate("Second activity");
    await settleLitElement(sidebar);
    projectRows.mockClear();
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    await vi.advanceTimersByTimeAsync(1_499);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    expect(sections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("Second activity");
    expect(row(target.key)?.textContent).not.toContain("First activity");
    expect(sections).toHaveBeenCalledTimes(1);
    expect(projectRows).not.toHaveBeenCalled();
  });
});
