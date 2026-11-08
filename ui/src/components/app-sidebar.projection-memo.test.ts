/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { makeBootRoster } from "../app/bootstrap.test-support.ts";
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
import { setSessionsGrouping } from "./session-organizer-menu.runtime.ts";
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

const session = (name: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: key(name),
  sessionId: `session-${name}`,
  kind: "direct",
  label: name,
  updatedAt: 1,
  createdAt: 1,
  owner: { actor: ada },
  ...fields,
});

const createQuestionClient = () => createTestGatewayClient(vi.fn(async () => ({ questions: [] })));

async function mount(rows: GatewaySessionRow[]) {
  const sessions = createSessionsHarness("main", []);
  const publish = (next: GatewaySessionRow[]) =>
    sessions.publishList({
      result: {
        ...sessions.sessions.state.result!,
        sessions: next,
        count: next.length,
        owners: structuredClone([ada, bob]),
      },
    });
  publish(rows);
  const gateway = createGatewayHarness(createQuestionClient());
  const context = createContext(
    gateway.gateway,
    sessions.sessions,
    makeBootRoster({ agents: [{ id: "main" }, { id: "work" }] }),
  );
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

async function advanceSidebarTime(sidebar: Sidebar, milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settleLitElement(sidebar);
}

async function restoreCachedRows(
  { sidebar, sessions }: Awaited<ReturnType<typeof mount>>,
  rows: GatewaySessionRow[],
  section: Omit<SidebarSnapshotModel["sections"][number], "id" | "rows" | "renderHeader">,
  grouping?: SidebarSnapshotModel["grouping"],
) {
  const owner = getAppSidebarOwner(sidebar.hostElement)!;
  vi.spyOn(owner, "sidebarSnapshotSettled").mockReturnValue(false);
  const navigation = sidebar.getSessionNavigationState();
  owner.restoreSidebarSnapshot({
    ...sidebarBootSnapshot(captureBootRoster(sessions.sessions.state)),
    mode: "chip",
    grouping,
    sections: [
      {
        id: "ungrouped",
        rows: snapshotSessions(rows.map((row) => navigation.toSidebarSession(row))),
        renderHeader: false,
        ...section,
      },
    ],
  });
  owner.invalidate();
  await settleLitElement(sidebar);
  return owner;
}

describe("sidebar projection memo", () => {
  it("keeps a saved group collapsed when opening its top-level session", async () => {
    const storageKey = "openclaw:sidebar:sessions:collapsed-sections";
    const saved = JSON.stringify(["category:Alpha"]);
    localStorage.setItem(storageKey, saved);
    const current = session("alpha", { category: "Alpha" });
    const { sidebar } = await mount([current]);

    await update(sidebar, { activeRouteId: "chat", sessionKey: current.key });

    const group = sidebar.querySelector('[data-session-section="category:Alpha"]');
    expect(group).not.toBeNull();
    expect(
      group?.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(group?.querySelector(".sidebar-recent-session")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe(saved);
  });

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

  it("shares one cached row graph between navigation, geometry and badge consumers", async () => {
    const target = session("shared-cached-row", { unread: true });
    const mounted = await mount([target]);
    const { sidebar } = mounted;
    const owner = await restoreCachedRows(mounted, [target], {
      totalRowCount: 1,
      visibleRowCount: 1,
      visibleLimit: 10,
      collapsedVisibleRowCount: 1,
    });
    const navigationRow = owner.findSidebarMenuSessionByKey(target.key);
    const badgeRow = () => owner.readSessionPullRequestRows().find((row) => row.key === target.key);
    expect(navigationRow).toBeDefined();
    expect(badgeRow()).toBe(navigationRow);
    expect(owner.reconciledSidebarZone().sessionRows.get(target.key)).toBe(navigationRow);
    await update(sidebar, { activeRouteId: "chat", sessionKey: target.key });
    const selected = owner.findSidebarMenuSessionByKey(target.key);
    expect(selected?.visuallyActive).toBe(true);
    expect(badgeRow()).toBe(selected);
    expect(owner.reconciledSidebarZone().sessionRows.get(target.key)).toBe(selected);
  });

  it.each([
    { savedGrouping: "none", grouping: "none", limit: undefined, expected: 45 },
    { savedGrouping: "none", grouping: "category", limit: undefined, expected: 15 },
    { savedGrouping: "category", grouping: "none", limit: undefined, expected: 30 },
    { savedGrouping: "category", grouping: "category", limit: 15, expected: 15 },
    { savedGrouping: "category", grouping: "category", limit: 60, expected: 60 },
    { savedGrouping: undefined, grouping: "none", limit: undefined, expected: 30 },
  ] as const)(
    "keeps $savedGrouping pagination isolated in $grouping through cached handoff",
    async ({ savedGrouping, grouping, limit, expected }) => {
      const sessionsToShow = Array.from({ length: 61 }, (_, index) => session(`row-${index}`));
      const mounted = await mount(sessionsToShow);
      const { sidebar } = mounted;
      const owner = getAppSidebarOwner(sidebar.hostElement)!;
      const sectionId = "ungrouped";
      expect(
        sidebar.querySelector("[data-session-section]")?.getAttribute("data-session-section"),
      ).toBe(sectionId);
      setSessionsGrouping(owner.sessionOrganizer, savedGrouping ?? "category");
      await restoreCachedRows(
        mounted,
        sessionsToShow.slice(0, 45),
        {
          totalRowCount: 61,
          visibleRowCount: 45,
          visibleLimit: 45,
          collapsedVisibleRowCount: savedGrouping === "none" ? 30 : 15,
        },
        savedGrouping,
      );
      setSessionsGrouping(owner.sessionOrganizer, grouping);
      if (grouping !== (savedGrouping ?? "category")) {
        await settleLitElement(sidebar);
        expect(
          sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
        ).toHaveLength(expected);
      }
      if (limit !== undefined) {
        owner.setVisibleSessionLimit(sectionId, limit);
      }
      owner.releaseSidebarSnapshot();
      owner.invalidate();
      await settleLitElement(sidebar);
      expect(
        sidebar.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
      ).toHaveLength(expected);
    },
  );

  it("prepares initially hidden session rows from shell inputs while keeping later owner updates parked", async () => {
    const target = session("question-proof");
    const sessions = createSessionsHarness("main", []);
    const client = createQuestionClient();
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
    const clones = vi.spyOn(Node.prototype, "cloneNode");
    const imports = vi.spyOn(document, "importNode");
    const pending = createDeferred<SidebarSnapshotModel | null>();
    const read = vi
      .spyOn(SessionSnapshotStore.prototype, "readSidebar")
      .mockReturnValue(pending.promise);
    const sessions = createSessionsHarness("main", [key("cached")]);
    const gateway = createGatewayHarness(createQuestionClient());
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
    const frames = new Set(
      [...clones.mock.results, ...imports.mock.results]
        .filter((result) => result.type === "return")
        .map((result) => result.value)
        .filter((node) => node instanceof Element && node.matches("aside.sidebar")),
    );
    expect(frames.size).toBe(1);
    host.remove();
    await settleLitElement(sidebar);
    provider.append(host);
    await waitForSolid(() =>
      expect(host.querySelector("aside.sidebar")?.getAttribute("data-snapshot-state")).toBe("live"),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("adds no sidebar placeholder for a create; the listed row arrives while naming runs", async () => {
    const old = session("old");
    const created = session("dashboard:creating", { label: undefined, titlePending: true });
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
      expect(sidebar.querySelector(".skeleton")).toBeNull();
      expect(row(created.key)).toBeNull();
      creation.admitted = true;
      context.chatSubmissions.acceptCreate({
        creation,
        displayName: "Accepted title",
        canDisplay: () => true,
      });
      await settleLitElement(sidebar);
      // The local accepted title never paints a stand-in row.
      expect(sidebar.textContent).not.toContain("Accepted title");
      publish([created, old]);
      await settleLitElement(sidebar);
      const listed = row(created.key);
      expect(listed?.classList.contains("sidebar-recent-session--naming")).toBe(true);
      expect(listed?.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(sidebar.querySelector(".skeleton")).toBeNull();
      expect(context.chatSubmissions.readAcceptedCreate()).toBeUndefined();
      publish([{ ...created, label: "Release review", titlePending: false }, old]);
      await settleLitElement(sidebar);
      expect(row(created.key)).toBe(listed);
      expect(listed?.classList.contains("sidebar-recent-session--naming")).toBe(false);
      expect(listed?.querySelector('[aria-busy="true"]')).toBeNull();
      expect(listed?.textContent).toContain("Release review");
    } finally {
      release();
    }
  });

  it("refreshes Home and selection while retaining held rows across descriptor changes", async () => {
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
    const owner = getAppSidebarOwner(sidebar.hostElement)!;
    projectRows.mockClear();
    await update(sidebar, () => {
      owner.sessionData.activeSessionLineageSelectedRow = { ...first, label: "Detail title" };
      owner.invalidate();
    });
    expect(projectRows).not.toHaveBeenCalled();
    expect(row(first.key)).toBe(firstRow);
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

    const outside = session("outside");
    await update(sidebar, () => {
      owner.sessionData.activeSessionLineageSelectedRow = outside;
      sidebar.sessionKey = outside.key;
      owner.invalidate();
    });
    expect(row(outside.key)?.textContent).toContain("outside");
    await update(sidebar, () => {
      owner.sessionData.activeSessionLineageSelectedRow = { ...outside, label: "Updated detail" };
      owner.invalidate();
    });
    expect(row(outside.key)?.textContent).toContain("Updated detail");
    expect(row(outside.key)?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
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
      await advanceSidebarTime(sidebar, 999);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");
      await advanceSidebarTime(sidebar, 2);
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

    await advanceSidebarTime(sidebar, 11_001 - Date.now());
    expect(row(first.key)).toBeNull();
    expect(row(second.key)).not.toBeNull();

    await advanceSidebarTime(sidebar, 12_001 - Date.now());
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
    const attention = (kind: string) =>
      row(target.key)?.querySelector(`[data-session-attention="${kind}"]`);
    expect(attention("agent")).not.toBeNull();
    projectRows.mockClear();
    // Mount readiness advances fake timers; stop before the expiry invalidation turn.
    await advanceSidebarTime(sidebar, expiresAt - Date.now());
    expect(projectRows).not.toHaveBeenCalled();
    expect(attention("agent")).not.toBeNull();
    await advanceSidebarTime(sidebar, 1);
    expect(projectRows).toHaveBeenCalled();
    expect(attention("agent")).toBeNull();
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
    expect(attention("question")?.getAttribute("aria-label")).toContain("Continue checking?");
    const parent = sidebar.hostElement.parentElement!;
    sidebar.hostElement.remove();
    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    expect(attention("question")).not.toBeNull();
    await update(sidebar, () =>
      gateway.publishEvent("question.resolved", { id: "question-memo", status: "cancelled" }),
    );
    expect(attention("question")).toBeNull();
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
    expect(attention("approval")?.getAttribute("aria-label")).toContain("git diff");
    await update(sidebar, () => publishApprovals([]));
    expect(attention("approval")).toBeNull();
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
    await advanceSidebarTime(sidebar, 1_499);
    expect(row(target.key)?.textContent).toContain("First activity");
    expect(sections).not.toHaveBeenCalled();
    await advanceSidebarTime(sidebar, 1);
    expect(row(target.key)?.textContent).toContain("Second activity");
    expect(row(target.key)?.textContent).not.toContain("First activity");
    expect(sections).toHaveBeenCalledTimes(1);
    expect(projectRows).not.toHaveBeenCalled();
  });
});
