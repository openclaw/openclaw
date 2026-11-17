/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { consumeSessionNavigationHandoff } from "../lib/sessions/navigation-handoff.ts";
import { bindChatPageSession } from "../pages/chat/chat-state-route.ts";
import {
  other,
  ownedSession,
  viewer,
  withOwnerSidebar,
} from "../test-helpers/agent-sidebar.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import { createSidebarElement } from "../test-helpers/app-sidebar.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";

it("keeps My sessions across real cross-agent row clicks, delayed refreshes, and remounts on a solo install", async () => {
  const rows = [
    ownedSession("agent:main:mine", viewer.id, { label: "Main conversation", updatedAt: 3000 }),
    ownedSession("agent:research:first", viewer.id, { label: "Research first", updatedAt: 2000 }),
    ownedSession("agent:research:second", viewer.id, { label: "Research second", updatedAt: 1000 }),
    ownedSession("agent:main:other", other.id, { label: "Other owner", updatedAt: 4000 }),
  ];
  await withOwnerSidebar(
    rows,
    [viewer, other],
    "personal",
    async (fixture) => {
      let sidebar = fixture.sidebar;
      const { context, settle } = fixture;
      const navigate = vi.fn<NonNullable<typeof sidebar.onNavigate>>((_route, options) => {
        const key = consumeSessionNavigationHandoff(context.gateway, options!.pathname!);
        expect(key).toBeTruthy();
        bindChatPageSession(context, key!);
        sidebar.sessionKey = key!;
      });
      sidebar.onNavigate = navigate;
      const expectRows = () => {
        for (const row of rows.slice(0, 3)) {
          expect(sidebar.querySelector(`[data-session-key="${row.key}"]`), row.key).not.toBeNull();
        }
        expect(sidebar.querySelector(`[data-session-key="${rows[3]!.key}"]`)).toBeNull();
        expect(sidebar.sidebarSessionOwnerFilter()).toEqual({
          ownerId: viewer.id,
          involvingMe: false,
        });
        expect(sidebar.sidebarSessionStatusFilter()).toBe("active");
      };
      await settle();
      expectRows();
      const client = context.gateway.snapshot.client!;
      const request = client.request.bind(client);
      let delayed: ReturnType<typeof createDeferred<void>> | undefined;
      const reads = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
        if (method === "sessions.list") {
          await delayed?.promise;
        }
        return request(method, params);
      });
      const click = async (index: number) => {
        const row = rows[index]!;
        sidebar
          .querySelector<HTMLAnchorElement>(
            `[data-session-key="${row.key}"] .sidebar-recent-session__link`,
          )!
          .click();
        await vi.waitFor(() => expect(sidebar.getRouteSessionKey()).toBe(row.key));
        await settleLitElement(sidebar);
        expect(context.agentSelection.state.selectedId).toBe(row.agentId);
        expectRows();
      };
      for (const index of [1, 0, 2, 0, 1]) {
        delayed = createDeferred();
        const refreshing = sidebar.sessionData.refreshSidebarSessions();
        await vi.waitFor(() => expect(sidebar.sessionData.sessionsLoading).toBe(true));
        try {
          await click(index);
        } finally {
          delayed.resolve();
          await refreshing;
        }
        await settleLitElement(sidebar);
        expectRows();
      }
      delayed = undefined;
      expect(reads).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ ownerId: viewer.id }),
      );
      const provider = sidebar.hostElement.parentElement!;
      const key = sidebar.getRouteSessionKey();
      sidebar.hostElement.remove();
      await settleLitElement(sidebar);
      sidebar = await createSidebarElement();
      sidebar.activeRouteId = "chat";
      sidebar.sidebarAgentsMode = "chip";
      sidebar.sessionKey = key;
      sidebar.onNavigate = navigate;
      provider.append(sidebar.hostElement);
      sidebar.connected = true;
      await settleLitElement(sidebar);
      await sidebar.sessionData.refreshSidebarSessions();
      await settleLitElement(sidebar);
      expectRows();
      await click(0);
      await click(2);

      // Explicit All owners and an agent choice still deliberately narrow browsing.
      await sidebar.sidebarMenus.preloadMenuRenderer();
      await selectSessionMenuValue(sidebar, "owner:");
      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
      await settleLitElement(sidebar);
      sidebar.querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:main"]')!.click();
      await settleLitElement(sidebar);
      await sidebar.sessionData.refreshSidebarSessions();
      await settleLitElement(sidebar);
      expect(context.agentSelection.state.selectedId).toBe("main");
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:research:first"]')).toBeNull();
      expect(reads).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "main" }),
      );
      await selectSessionMenuValue(sidebar, "owner:viewer");
      await settleLitElement(sidebar);
      expectRows();
    },
    {
      savedOwnerId: viewer.id,
      singleUser: true,
      ownersByAgent: { main: [viewer, other], research: [viewer] },
    },
  );
});

it("keeps legacy unowned rows in personal browsing without sending an owner filter", async () => {
  const rows = [
    ownedSession("agent:main:mine", viewer.id),
    { key: "agent:research:legacy", agentId: "research", kind: "direct" as const, label: "Legacy" },
  ];
  await withOwnerSidebar(
    rows,
    [viewer],
    "personal",
    async ({ sidebar, context, settle }) => {
      sidebar.onNavigate = (_route, options) => {
        const key = consumeSessionNavigationHandoff(context.gateway, options!.pathname!);
        expect(key).toBeTruthy();
        bindChatPageSession(context, key!);
        sidebar.sessionKey = key!;
      };
      await settle();
      sidebar
        .querySelector<HTMLAnchorElement>(
          '[data-session-key="agent:research:legacy"] .sidebar-recent-session__link',
        )!
        .click();
      await settle();
      expect(context.agentSelection.state.selectedId).toBe("research");
      await sidebar.sessionData.refreshSidebarSessions();
      await settle();
      for (const row of rows) {
        expect(sidebar.querySelector(`[data-session-key="${row.key}"]`)).not.toBeNull();
      }
      expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
      expect(sidebar.sessionData.sessionListQuery("research")).toMatchObject({
        ownerId: undefined,
        agentId: undefined,
      });
    },
    { savedOwnerId: viewer.id, singleUser: true },
  );
});
