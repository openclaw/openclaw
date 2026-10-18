/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createChatSubmissions } from "../app/chat-submissions.ts";
import type { ApplicationOverlaySnapshot } from "../app/overlays-types.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { admitSidebarBootScope } from "../pages/chat/session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  catalogPage,
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import * as sidebarAgentSessionRows from "./app-sidebar-agent-session-rows.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import type { SelectPicker } from "./select-picker.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";

type Sidebar = AppSidebarSessionNavigationElement;

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
    ...createContext(gateway.gateway, sessions.sessions, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "work" }],
    }),
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

async function expectRowRefresh(sidebar: Sidebar, change: () => void) {
  projectRows.mockClear();
  change();
  if (vi.isFakeTimers()) {
    vi.advanceTimersToNextFrame();
  }
  await settleLitElement(sidebar);
  expect(projectRows).toHaveBeenCalled();
}

describe("sidebar projection memo", () => {
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
    const context = createContext(gateway.gateway, sessions.sessions, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
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

  it("publishes a saved receipt without recapturing or replacing the sidebar", async () => {
    const written = createDeferred<boolean>();
    const write = vi
      .spyOn(SessionSnapshotStore.prototype, "writeSidebar")
      .mockReturnValue(written.promise);
    const { sidebar, context, gateway } = await mount([session("saved")]);
    Object.assign(context.plugins, { registryStatus: "complete" });
    context.sessions.captureBootRoster = () => captureBootRoster(context.sessions.state);
    sidebar.connected = true;
    gateway.publish({
      hello: {
        ...gatewayHelloForMethods([]),
        auth: { role: "operator", scopes: [], recoveryScope: "synthetic-account" },
      },
    });
    await waitForSolid(() => expect(write).toHaveBeenCalled());
    await settleLitElement(sidebar);
    const frame = sidebar.querySelector("aside.sidebar");
    expect(frame?.getAttribute("data-snapshot-saved")).toBe("false");
    const capture = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "captureSidebarSnapshot");
    projectRows.mockClear();
    written.resolve(true);
    await waitForSolid(() => expect(frame?.getAttribute("data-snapshot-saved")).toBe("true"));
    expect(sidebar.querySelector("aside.sidebar")).toBe(frame);
    expect(capture).not.toHaveBeenCalled();
    expect(projectRows).not.toHaveBeenCalled();
  });

  it("watches live PR rows after preparation releases the boot snapshot", async () => {
    const target = session("live-checkout", {
      worktree: { id: "wt-live", branch: "main", repoRoot: "/synthetic/repo" },
    });
    const { sidebar, gateway, sessions, row } = await mount([target]);
    sidebar.connected = true;
    gateway.publish({ hello: gatewayHelloForMethods([SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]) });
    await settleLitElement(sidebar);
    const owner = getAppSidebarOwner(sidebar.hostElement)!;
    expect(owner.sidebarSnapshotSettled()).toBe(true);
    expect(owner.readSessionPullRequestRows()).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: target.key, worktreeId: "wt-live" })]),
    );
    const cached = sidebarBootSnapshot(captureBootRoster(sessions.sessions.state));
    expect(cached.roster?.agentId).toBe(owner.expandedAgentId());
    owner.restoreSidebarSnapshot({ ...cached, mode: "chip" });
    owner.invalidate();
    await settleLitElement(sidebar);
    expect(owner.sidebarSnapshot).toBeNull();

    gateway.publishEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [target.key]: {
          pullRequests: [{ number: 42, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    await settleLitElement(sidebar);
    expect(sessionPullRequestsForGateway(gateway.gateway).get(target.key)?.pullRequests).toEqual([
      { number: 42, state: "open" },
    ]);
    expect(
      row(target.key)
        ?.querySelector('[data-pull-request-state="open"]')
        ?.getAttribute("aria-label"),
    ).toContain("#42");
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
    const ownerPicker = sidebar
      .querySelector("#sidebar-session-owner-title")!
      .closest<SelectPicker>("openclaw-select-picker")!;
    const ownerPickerParams = ownerPicker.params;
    const sections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    expect(projectHome).toHaveBeenCalled();
    projectHome.mockClear();
    projectRows.mockClear();
    for (const change of [
      () => {
        sidebar.invalidate();
      },
      () => {
        sidebar.devGitBranch = "feature/sidebar";
      },
      () => {
        sidebar.invalidate();
      },
      () => {
        sidebar.sidebarMenus.closePositionedMenu("sessionSort");
        sidebar.invalidate();
      },
    ]) {
      change();
      await settleLitElement(sidebar);
      expect(row(key("first"))?.textContent).toContain("first");
    }
    expect(projectRows).not.toHaveBeenCalled();
    expect(sections).not.toHaveBeenCalled();
    expect(projectHome).not.toHaveBeenCalled();
    expect(ownerPicker.params).toBe(ownerPickerParams);

    await expectRowRefresh(sidebar, () =>
      publish([
        { ...rows[0]!, lastMessagePreview: "Home after" },
        { ...rows[1]!, label: "Renamed first" },
        ...rows.slice(2),
      ]),
    );
    expect(row(key("first"))?.textContent).toContain("Renamed first");
    expect(ownerPicker.params).toBe(ownerPickerParams);
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
    expect(ownerPicker.querySelector("button")?.getAttribute("aria-label")).toContain("Bob");
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

  it("invalidates live attention, expiry, outbox snapshots, and store-owned PR and archive facts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const expiresAt = 11_000;
    const target = session("attention", {
      agentStatus: { note: "Waiting for credentials", attention: "key", expiresAt },
    });
    const { sidebar, sessions, gateway, row, publishApprovals } = await mount([target]);
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
    const parent = sidebar.hostElement.parentElement!;
    sidebar.hostElement.remove();
    parent.append(sidebar.hostElement);
    await settleLitElement(sidebar);
    expect(row(target.key)?.querySelector('[data-session-attention="question"]')).not.toBeNull();
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

  it.each(["done", "failed", "killed", "timeout"] as const)(
    "keeps activity through answer streaming and finishing until the run is %s",
    async (status) => {
      const target = session("answer", {
        hasActiveRun: true,
        activeRunIds: ["answer-run"],
        status: "running",
      });
      const other = session("other", {
        hasActiveRun: true,
        activeRunIds: ["other-run"],
        status: "running",
      });
      const { sidebar, gateway, row, sessions, publish } = await mount([target, other]);
      const spinner = (sessionKey: string) =>
        row(sessionKey)?.querySelector('[aria-label="Active run"]');
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 1,
        stream: "assistant",
        data: { text: "The answer is ready." },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      expect(spinner(other.key)).not.toBeNull();
      gateway.publishEvent("chat", {
        sessionKey: target.key,
        runId: "answer-run",
        state: "delta",
        replace: true,
        message: { role: "assistant", content: [] },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 2,
        stream: "item",
        data: {
          kind: "tool",
          phase: "start",
          itemId: "inspect",
          toolCallId: "inspect",
          name: "read_file",
          title: "Read file",
        },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 3,
        stream: "lifecycle",
        data: { phase: "finishing", error: "retryable" },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 4,
        stream: "run_status",
        data: { phase: "retrying", message: "Retrying" },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      gateway.publishEvent("agent", {
        sessionKey: target.key,
        runId: "answer-run",
        seq: 3,
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      await settleLitElement(sidebar);
      expect(spinner(target.key)).not.toBeNull();
      expect(sessions.sessions.state.result?.sessions[0]?.hasActiveRun).toBe(true);
      publish([{ ...target, hasActiveRun: false, activeRunIds: [], status }, other]);
      await settleLitElement(sidebar);
      expect(spinner(target.key)).toBeNull();
      expect(spinner(other.key)).not.toBeNull();
    },
  );

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
