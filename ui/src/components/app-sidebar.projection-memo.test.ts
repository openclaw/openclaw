/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationOverlaySnapshot } from "../app/overlays-types.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import {
  mountRoster,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import * as sidebarAgentSessionRows from "./app-sidebar-agent-session-rows.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import "./app-sidebar.ts";

type Sidebar = AppSidebarSessionNavigationElement & {
  teamOnlineExpanded: boolean;
  sidebarNarrationLines: ReadonlyMap<string, string>;
};

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
  const context = createContext(gateway.gateway, sessions.sessions, {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "work" }],
  });
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
      result: { ...sessions.sessions.state.result!, sessions: next, count: next.length },
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

async function expectRowRefresh(sidebar: Sidebar, change: () => void) {
  projectRows.mockClear();
  change();
  await settleLitElement(sidebar);
  expect(projectRows).toHaveBeenCalled();
}

describe("sidebar projection memo", () => {
  it("shares the projection across unrelated updates and refreshes route, list, and filter inputs", async () => {
    const projectHome = vi.spyOn(sidebarAgentSessionRows, "projectSidebarHomeSession");
    const rows = [
      session("main", { lastMessagePreview: "Home before" }),
      session("first", { updatedAt: 2, createdAt: 3 }),
      session("second", { updatedAt: 3, createdAt: 2, owner: { actor: bob } }),
      session("cron:daily", { label: "Scheduled check" }),
      session("explicit:healthcheck", { createdVia: "run", label: "System check" }),
      session("archived", { archived: true }),
      ...Array.from({ length: 20 }, (_, index) => session(`thread-${index}`)),
    ];
    const { sidebar, sessions, row, publish } = await mount(rows);
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    expect(projectHome).toHaveBeenCalled();
    projectHome.mockClear();
    projectRows.mockClear();
    for (const change of [
      () => {
        sidebar.teamOnlineExpanded = true;
      },
      () => {
        sidebar.devGitBranch = "feature/sidebar";
      },
      () => {
        sidebar.teamOnlineExpanded = false;
      },
      () => {
        sidebar.sidebarMenus.closePositionedMenu("sessionSort");
        sidebar.requestUpdate();
      },
    ]) {
      change();
      await settleLitElement(sidebar);
      expect(row(key("first"))?.textContent).toContain("first");
    }
    expect(projectRows).not.toHaveBeenCalled();
    expect(sections).not.toHaveBeenCalled();
    expect(projectHome).not.toHaveBeenCalled();

    await expectRowRefresh(sidebar, () =>
      publish([
        { ...rows[0]!, lastMessagePreview: "Home after" },
        { ...rows[1]!, label: "Renamed first" },
        ...rows.slice(2),
      ]),
    );
    expect(row(key("first"))?.textContent).toContain("Renamed first");
    expect(projectHome).toHaveBeenCalled();
    expect(projectHome.mock.results.at(-1)?.value.lastMessagePreview).toBe("Home after");
    await expectRowRefresh(sidebar, () => {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key("first");
    });
    expect(sidebar.findSidebarSessionByKey(key("first"))?.visuallyActive).toBe(true);
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionKey = key("second");
    });
    expect(sidebar.findSidebarSessionByKey(key("first"))?.visuallyActive).toBe(false);
    expect(sidebar.findSidebarSessionByKey(key("second"))?.visuallyActive).toBe(true);

    await expectRowRefresh(sidebar, () => {
      sidebar.setSessionSortMode("updated");
    });
    expect(sidebar.querySelector("[data-session-key]")?.getAttribute("data-session-key")).toBe(
      key("second"),
    );
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionsShowCron = true;
    });
    expect(row(key("cron:daily"))).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionsShowSystem = true;
    });
    expect(row(key("explicit:healthcheck"))).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionsStatusFilter = "all";
    });
    expect(row(key("archived"))).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.setSessionOwnerFilter("bob");
    });
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    expect(row(key("second"))).not.toBeNull();
    expect(row(key("first"))).toBeNull();
    const options = sidebar.sessionOwnerOptions;
    projectRows.mockClear();
    sidebar.devGitBranch = "another-branch";
    await settleLitElement(sidebar);
    expect(sidebar.sessionOwnerOptions).toBe(options);
    expect(sidebar.sessionOwnerFilterId).toBe("bob");
    expect(projectRows).not.toHaveBeenCalled();

    sidebar.setSessionOwnerFilter(null);
    sidebar.sessionsStatusFilter = "active";
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    const work = { ...session("work-thread"), key: "agent:work:thread", label: "Work thread" };
    sessions.publishList({
      agentId: "work",
      result: { ...sessions.sessions.state.result!, sessions: [work], count: 1 },
    });
    await settleLitElement(sidebar);
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionDataContext!.agentSelection.set("work");
    });
    expect(row(work.key)?.textContent).toContain("Work thread");
    expect(row(key("first"))).toBeNull();
  });

  it.each(["active", "snoozed"] as const)(
    "refreshes %s row visibility when a cached snooze expires without another input",
    async (statusFilter) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const target = session("snoozed", { snoozedUntil: 11_000, snoozedAt: 9_000 });
      const { sidebar, row } = await mount([target]);
      sidebar.sessionsStatusFilter = statusFilter;
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");

      sidebar.teamOnlineExpanded = true;
      await settleLitElement(sidebar);
      await vi.advanceTimersByTimeAsync(999);
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "snoozed");

      await vi.advanceTimersByTimeAsync(2);
      await settleLitElement(sidebar);
      expect(row(target.key) !== null).toBe(statusFilter === "active");
    },
  );

  it("hides and wakes an adopted catalog row using its cached agent result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const target = session("adopted", { key: "agent:work:adopted", agentId: "work" });
    const { sidebar, sessions, row } = await mount([]);
    const cachedResult = {
      ...sessions.sessions.state.result!,
      sessions: [target],
      count: 1,
    };
    sidebar.sessionData.sessionResultsByAgent = { work: cachedResult };
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "fixture",
        label: "Fixture",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:fixture",
            label: "Fixture host",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "adopted-thread",
                sessionKey: target.key,
                name: "Adopted catalog thread",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ];
    sidebar.requestUpdate();
    await settleLitElement(sidebar);
    expect(row(target.key)?.hasAttribute("data-catalog-session-key")).toBe(true);

    sidebar.sessionData.sessionResultsByAgent = {
      work: {
        ...cachedResult,
        sessions: [{ ...target, snoozedUntil: 11_000, snoozedAt: 10_000 }],
      },
    };
    sidebar.requestUpdate();
    await settleLitElement(sidebar);
    expect(row(target.key)).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    await settleLitElement(sidebar);
    expect(row(target.key)).toBeNull();

    await vi.advanceTimersByTimeAsync(2);
    await settleLitElement(sidebar);
    expect(row(target.key)?.hasAttribute("data-catalog-session-key")).toBe(true);
    expect(row(target.key)?.textContent).toContain("adopted");
  });

  it("updates roster selection and menu state without reprojecting rows or sections", async () => {
    const mounted = await mountRoster();
    const sidebar = mounted.sidebar as unknown as Sidebar;
    sidebar.sidebarAgentsMode = "roster";
    await settleRoster(mounted.sidebar);
    await rosterActivityStore(mounted.context).refresh();
    await settleRoster(mounted.sidebar);
    const sessionKey = "agent:main:recent";
    const row = () => sidebar.querySelector(`[data-session-key="${sessionKey}"]`);
    expect(row()).not.toBeNull();
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    projectRows.mockClear();
    sidebar.selectedSessionKeys = new Set([sessionKey]);
    await settleRoster(mounted.sidebar);
    expect(row()?.classList.contains("sidebar-recent-session--selected")).toBe(true);
    row()!.querySelector<HTMLButtonElement>("[data-sidebar-session-menu]")!.click();
    await settleRoster(mounted.sidebar);
    expect(row()?.querySelector("[data-sidebar-session-menu]")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    sidebar.sidebarMenus.closeSessionMenu();
    sidebar.clearSessionSelection();
    await settleRoster(mounted.sidebar);
    expect(row()?.classList.contains("sidebar-recent-session--selected")).toBe(false);
    expect(row()?.querySelector("[data-sidebar-session-menu]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(projectRows).not.toHaveBeenCalled();
    expect(sections).not.toHaveBeenCalled();
  });

  it("invalidates live attention, expiry, outbox snapshots, and store-owned PR and archive facts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const target = session("attention", {
      agentStatus: { note: "Waiting for credentials", attention: "key", expiresAt: 11_000 },
    });
    const { sidebar, sessions, gateway, row, publishApprovals } = await mount([target]);
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    projectRows.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    await settleLitElement(sidebar);
    expect(projectRows).not.toHaveBeenCalled();
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await settleLitElement(sidebar);
    expect(projectRows).toHaveBeenCalled();
    expect(row(target.key)?.querySelector('[data-session-attention="agent"]')).toBeNull();
    await expectRowRefresh(sidebar, () =>
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
    await expectRowRefresh(sidebar, () =>
      gateway.publishEvent("question.resolved", { id: "question-memo", status: "cancelled" }),
    );
    await expectRowRefresh(sidebar, () =>
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
    await expectRowRefresh(sidebar, () => publishApprovals([]));
    await expectRowRefresh(sidebar, () => {
      sidebar.storedOutboxes = {
        total: 2,
        attentionCountForSession: (sessionKey) => (sessionKey === target.key ? 2 : 0),
        hasSessionDraft: (sessionKey) => sessionKey === target.key,
      };
    });
    expect(row(target.key)?.querySelector(".session-row-badge--attention")?.textContent).toContain(
      "2",
    );
    expect(row(target.key)?.querySelector(".session-row-badge--draft")).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.storedOutboxes = undefined;
    });
    expect(row(target.key)?.querySelector(".session-row-badge--draft")).toBeNull();
    await expectRowRefresh(sidebar, () =>
      sessions.sessions.setPullRequestSummary(target.key, { numbers: [42], state: "open" }),
    );
    expect(sidebar.findSidebarSessionByKey(target.key)?.pullRequest).toMatchObject({
      numbers: [42],
      state: "open",
    });
    expect(row(target.key)?.querySelector('[data-pull-request-state="open"]')).not.toBeNull();
    let cancel: (() => void) | null = null;
    await expectRowRefresh(sidebar, () => {
      cancel = sessions.sessions.beginArchive(target.key, target.sessionId);
    });
    expect(row(target.key)).toBeNull();
    await expectRowRefresh(sidebar, () => {
      cancel?.();
    });
    expect(row(target.key)).not.toBeNull();
  });

  it("refreshes catalog visibility and child loading while expansion only refreshes sections", async () => {
    const parent = session("parent", { childSessions: [key("child")] });
    const child = session("child", { spawnedBy: parent.key });
    const { sidebar, row, sessions } = await mount([parent, child]);
    sessions.list.mockResolvedValue({
      ...sessions.sessions.state.result!,
      sessions: [child],
      count: 1,
    });
    // An active parent retains its child observation even while collapsed.
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = parent.key;
    await sidebar.sessionData.loadChildSessions(parent.key);
    await settleLitElement(sidebar);
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    projectRows.mockClear();
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
    await settleLitElement(sidebar);
    expect(sections).toHaveBeenCalled();
    expect(projectRows).not.toHaveBeenCalled();
    expect(row(child.key)).not.toBeNull();
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionData.loadingChildSessionKeys = new Set([parent.key]);
      sidebar.requestUpdate();
    });
    expect(
      projectRows.mock.results
        .at(-1)
        ?.value.find((value: { key: string }) => value.key === parent.key)?.loadingChildren,
    ).toBe(true);
    const catalog: SessionCatalog = {
      id: "fixture",
      label: "Fixture",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:fixture",
          label: "Fixture host",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "catalog-thread",
              name: "Catalog thread",
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
            },
          ],
        },
      ],
    };
    await expectRowRefresh(sidebar, () => {
      sidebar.sessionData.sessionCatalogs = [catalog];
      sidebar.requestUpdate();
    });
    expect(sidebar.textContent).toContain("Catalog thread");
    await expectRowRefresh(sidebar, () => {
      sidebar.hiddenSessionCatalogIds = new Set([catalog.id]);
    });
    expect(sidebar.textContent).not.toContain("Catalog thread");
  });

  it("replaces held running subtitles at their deadline without another input or full row projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const target = session("running", {
      hasActiveRun: true,
      activeRunIds: ["run-memo"],
      status: "running",
    });
    const { sidebar, row } = await mount([target]);
    sidebar.sessionsShowPreview = true;
    sidebar.sidebarLiveActivity = true;
    sidebar.sidebarNarrationLines = new Map([[target.key, "First activity"]]);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
    await vi.advanceTimersByTimeAsync(500);
    sidebar.sidebarNarrationLines = new Map([[target.key, "Second activity"]]);
    await settleLitElement(sidebar);
    expect(row(target.key)?.textContent).toContain("First activity");
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
