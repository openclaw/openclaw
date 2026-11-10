/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { bindChatPageSession } from "../pages/chat/chat-state-route.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  other,
  ownedSession,
  viewer,
  withOwnerSidebar,
} from "../test-helpers/agent-sidebar.test-support.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";

it("keeps selected owners across agents and resumes the selected agent's own conversation", async () => {
  const rows: GatewaySessionRow[] = [
    ownedSession("agent:main:mine", "viewer"),
    ownedSession("agent:research:shared", "other", {
      updatedAt: 3000,
      unread: true,
    }),
    ownedSession("agent:research:dashboard:00000002-0000-4000-8000-000000000000", "viewer", {
      updatedAt: 2000,
      unread: true,
    }),
    ownedSession("agent:research:main", "viewer", {
      updatedAt: 1000,
      hasActiveRun: true,
      status: "running",
    }),
  ];
  await withOwnerSidebar(
    rows,
    [viewer, other],
    "personal",
    async ({ sidebar, context, requests, inventoryRequests, gateway }) => {
      const visit = async (row: GatewaySessionRow, refresh = true) => {
        bindChatPageSession(context, row.key);
        sidebar.sessionKey = row.key;
        await settleLitElement(sidebar);
        if (refresh) {
          await sidebar.sessionData.refreshSidebarSessions();
          await settleLitElement(sidebar);
        }
      };
      for (const row of [rows[1]!, rows[0]!, rows[1]!]) {
        await visit(row);

        expect(context.agentSelection.state.selectedId).toBe(row.agentId);
        expect(sidebar.getRouteSessionKey()).toBe(row.key);
        expect(requests.at(-1)).toMatchObject({ agentId: row.agentId, ownerId: viewer.id });
        expect(sidebar.querySelector('[data-session-key="agent:main:mine"]') !== null).toBe(
          row.agentId === "main",
        );
        expect(sidebar.querySelector('[data-session-key="agent:research:shared"]')).toBeNull();
        expect(sidebar.querySelector(`[data-session-key="${rows[2]!.key}"]`) !== null).toBe(
          row.agentId === "research",
        );
      }

      await visit(rows[0]!);

      // A selected owner remains narrowed to the open agent, including an empty result.
      await sidebar.sidebarMenus.preloadMenuRenderer();
      await selectSessionMenuValue(sidebar, "status:all");
      await selectSessionMenuValue(sidebar, "owner:other");
      await settleLitElement(sidebar);
      expect(sidebar.getRouteSessionKey()).toBe("agent:main:mine");
      expect(requests.at(-1)).toMatchObject({ agentId: "main", ownerId: other.id });
      expect(sidebar.querySelector('[data-session-key="agent:research:shared"]')).toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
      expect(sidebar.sessionOwnerFilter.read().ownerId).toBe(other.id);
      await selectSessionMenuValue(sidebar, "owner:viewer");

      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      expect(inventoryRequests).toHaveLength(0);
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settleLitElement(sidebar);
      expect.soft(inventoryRequests).toHaveLength(1);
      expect.soft(inventoryRequests[0]).toMatchObject({ source: "agent-roster", archived: "all" });
      const researchMenuItem = sidebar.querySelector<HTMLElement>(
        '.sidebar-agent-menu [data-value="agent:research"]',
      )!;
      expect.soft(researchMenuItem.querySelector('[aria-label="Unread"]')).not.toBeNull();
      researchMenuItem.click();
      await vi.waitFor(() =>
        expect(onNavigate).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            pathname: "/chat/research/00000002000040008000000000000000",
          }),
        ),
      );

      await visit(rows[2]!, false);
      const home = sidebar.querySelector<HTMLElement>(".sidebar-footer-bar__home")!;
      expect.soft(home.querySelector('[aria-label="Active run"]')).not.toBeNull();

      rows[2]!.unread = false;
      gateway.publishEvent("sessions.changed", {
        reason: "patch",
        agentId: "research",
        sessionKey: rows[2]!.key,
        session: { ...rows[2]!, snapshotAt: Date.now() + 1 },
        ancestorSessions: [],
      });
      await visit(rows[0]!);
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settleLitElement(sidebar);
      expect(
        sidebar.querySelector(
          '.sidebar-agent-menu [data-value="agent:research"] [aria-label="Unread"]',
        ),
      ).toBeNull();
    },
    viewer.id,
  );
});

it("keeps an explicitly empty route selection instead of discovering ambient Home", async () => {
  await withOwnerSidebar([], [viewer], "personal", async ({ sidebar, context }) => {
    context.gateway.snapshot.sessionKey = "agent:main:main";
    sidebar.sessionKey = "";
    await settleLitElement(sidebar);
    expect(sidebar.getRouteSessionKey()).toBe("");
  });
});

it("resumes a loaded owner-scoped conversation omitted by the bounded agent roster", async () => {
  const research = ownedSession(
    "agent:research:dashboard:00000002-0000-4000-8000-000000000000",
    "viewer",
    {
      updatedAt: 2000,
      unread: true,
    },
  );
  const main = ownedSession("agent:main:mine", "viewer", { updatedAt: 1000 });
  const newerOtherSessions = Array.from({ length: 300 }, (_, index) =>
    ownedSession(`agent:main:other-${index}`, "other", { updatedAt: 5000 - index }),
  );
  await withOwnerSidebar(
    [...newerOtherSessions, research, main],
    [viewer, other],
    "personal",
    async ({ sidebar, context, settle }) => {
      bindChatPageSession(context, research.key);
      sidebar.sessionKey = research.key;
      await settleLitElement(sidebar);
      await sidebar.sessionData.refreshSidebarSessions();
      await settle();
      expect(
        sidebar.sessionData.resultForAgent("research")?.sessions.map((row) => row.key),
      ).toContain(research.key);
      bindChatPageSession(context, "agent:research:main");
      sidebar.sessionKey = "agent:research:main";
      await settle();
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      await sidebar.sidebarMenus.preloadMenuRenderer();
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settleLitElement(sidebar);
      expect(
        sidebar.sessionData.resultForAgent("research")?.sessions.map((row) => row.key),
      ).toContain(research.key);
      const item = sidebar.querySelector<HTMLElement>(
        '.sidebar-agent-menu [data-value="agent:research"]',
      )!;
      item.click();
      await vi.waitFor(() =>
        expect(onNavigate).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ pathname: "/chat/research/00000002000040008000000000000000" }),
        ),
      );
      await selectSessionMenuValue(sidebar, "owner:other");
      await settle();
      onNavigate.mockClear();
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settle();
      sidebar
        .querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:research"]')!
        .click();
      await vi.waitFor(() =>
        expect(onNavigate).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ pathname: "/chat/research" }),
        ),
      );
    },
    viewer.id,
  );
});

it("does not resume a loaded conversation that the Gateway no longer returns", async () => {
  const row = ownedSession(
    "agent:research:dashboard:00000002-0000-4000-8000-000000000000",
    "viewer",
    { updatedAt: 2000 },
  );
  const rows = [row];
  await withOwnerSidebar(
    rows,
    [viewer, other],
    "personal",
    async ({ sidebar, context, settle }) => {
      bindChatPageSession(context, row.key);
      sidebar.sessionKey = row.key;
      await settle();
      await sidebar.sessionData.refreshSidebarSessions();
      await settle();
      expect(sidebar.sessionData.sessionsResult?.sessions.map((session) => session.key)).toContain(
        row.key,
      );
      rows.splice(0, 1); // The same response covers deletion and a revoked read grant.
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      await sidebar.sidebarMenus.preloadMenuRenderer();
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settle();
      sidebar
        .querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:research"]')!
        .click();
      await vi.waitFor(() =>
        expect(onNavigate).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ pathname: "/chat/research" }),
        ),
      );
    },
    viewer.id,
  );
});

it("discards an in-flight agent selection when the owner filter changes", async () => {
  const row = ownedSession(
    "agent:research:dashboard:00000002-0000-4000-8000-000000000000",
    "viewer",
    { updatedAt: 2000 },
  );
  let hold = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await withOwnerSidebar(
    [row],
    [viewer, other],
    "personal",
    async ({ sidebar, settle }) => {
      await settle();
      await sidebar.sidebarMenus.preloadMenuRenderer();
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settle();
      hold = true;
      sidebar
        .querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:research"]')!
        .click();
      await vi.waitFor(() => expect(started).toBe(true));
      hold = false;
      await selectSessionMenuValue(sidebar, "owner:other");
      await settle();
      release!();
      await settle();
      expect(onNavigate).not.toHaveBeenCalled();
    },
    viewer.id,
    (params, rows) => {
      if (!hold || params.source !== "sidebar" || params.agentId !== "research") {
        return undefined;
      }
      started = true;
      return held.then(() => ({ ...sessionsResult(rows, 1), owners: [viewer, other] }));
    },
  );
});

it("does not navigate from cached rows when the Gateway denies the fresh read", async () => {
  let deny = false;
  let rejected = false;
  const row = ownedSession(
    "agent:research:dashboard:00000002-0000-4000-8000-000000000000",
    "viewer",
  );
  await withOwnerSidebar(
    [row],
    [viewer, other],
    "personal",
    async ({ sidebar, settle }) => {
      await settle();
      await sidebar.sidebarMenus.preloadMenuRenderer();
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settle();
      deny = true;
      sidebar
        .querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:research"]')!
        .click();
      await vi.waitFor(() => expect(rejected).toBe(true));
      await settle();
      expect(onNavigate).not.toHaveBeenCalled();
    },
    viewer.id,
    (params) => {
      if (!deny || params.agentId !== "research") {
        return undefined;
      }
      rejected = true;
      return Promise.reject(new Error("access denied"));
    },
  );
});

it("does not start a delayed picker action after the active agent changes", async () => {
  const row = ownedSession(
    "agent:research:dashboard:00000002-0000-4000-8000-000000000000",
    "viewer",
  );
  await withOwnerSidebar(
    [row],
    [viewer, other],
    "personal",
    async ({ sidebar, context, settle }) => {
      await settle();
      await sidebar.sidebarMenus.preloadMenuRenderer();
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settle();
      sidebar
        .querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:research"]')!
        .click();
      context.agentSelection.set("research");
      await settle();
      expect(onNavigate).not.toHaveBeenCalled();
    },
    viewer.id,
  );
});
