/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  other,
  ownedSession,
  viewer,
  withOwnerSidebar,
} from "../test-helpers/agent-sidebar.test-support.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { snapshotSessions } from "./sidebar-snapshot-model.ts";

const mine = () =>
  ownedSession("agent:main:mine", viewer.id, { label: "My session", owner: { actor: viewer } });

it.each(["visible", "bounded"])(
  "keeps solo legacy sessions and settles when their participants are %s",
  async (participants) => {
    const legacy: GatewaySessionRow = {
      key: "agent:main:legacy",
      agentId: "main",
      kind: "direct" as const,
      label: "Legacy session",
      participants:
        participants === "visible" ? [{ identity: { type: "agent", id: "research" } }] : [],
      participantCount: 1,
    };
    await withOwnerSidebar(
      [mine(), legacy],
      [viewer],
      "query",
      async ({ sidebar, requests, settle }) => {
        await settle();
        expect(requests).toHaveLength(1);
        expect(requests[0]?.ownerId).toBeUndefined();
        for (const key of ["mine", "legacy"]) {
          expect(sidebar.querySelector(`[data-session-key="agent:main:${key}"]`)).not.toBeNull();
        }
      },
    );
  },
);

it("settles with multiple owners and keeps an explicitly selected owner's empty list", async () => {
  await withOwnerSidebar(
    [mine()],
    [viewer, other],
    "query",
    async ({ sidebar, requests, settle }) => {
      await settle();
      expect(requests.length).toBeLessThanOrEqual(2);
      expect(requests.at(-1)?.ownerId).toBe("viewer");
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
      await sidebar.sidebarMenus.preloadMenuRenderer();
      await selectSessionMenuValue(sidebar, "owner:other");
      await settle();
      expect(requests.at(-1)?.ownerId).toBe("other");
      expect(requests.length).toBeLessThanOrEqual(3);
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
      expect(sidebar.querySelector("#sidebar-session-owner-title")?.textContent).toContain("Other");
    },
  );
});

it("does not include an agent's sessions when its ID equals the signed-in human's ID", async () => {
  const agent = { type: "agent" as const, id: viewer.id, label: "Agent" };
  await withOwnerSidebar(
    [{ ...mine(), owner: { actor: agent } }],
    [agent],
    "query",
    async ({ sidebar, requests, settle }) => {
      await settle();
      expect(requests.length).toBeLessThanOrEqual(2);
      expect(requests.at(-1)?.ownerId).toBe("viewer");
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
    },
  );
});

it.each(["owner", "involving-me", "refresh"])(
  "keeps cached rows until the selected %s query completes",
  async (selection) => {
    const idle = vi
      .fn<(callback: IdleRequestCallback, options?: IdleRequestOptions) => number>()
      .mockReturnValue(1);
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const actor = selection === "refresh" ? viewer : other;
    const replacement = ownedSession("agent:main:replacement", actor.id, {
      label: "Replacement session",
      owner: { actor },
      participants: [{ identity: { type: "profile", id: viewer.id } }],
    });
    const stale = { ...replacement, key: "agent:main:stale", label: "Stale query result" };
    await withOwnerSidebar(
      selection === "refresh" ? [mine(), stale] : [mine()],
      [viewer, other],
      "query",
      async ({ sidebar, context, settle }) => {
        await settle();
        const rows = snapshotSessions(
          [mine()].map((row) => sidebar.getSessionNavigationState().toSidebarSession(row)),
        );
        sidebar.restoreSidebarSnapshot({
          ...sidebarBootSnapshot(captureBootRoster(context.sessions.state)),
          ownerId: viewer.id,
          mode: "chip",
          sessions: rows,
          sections: [
            {
              id: "ungrouped",
              rows,
              totalRowCount: 1,
              visibleRowCount: 1,
              visibleLimit: 10,
              collapsedVisibleRowCount: 1,
              renderHeader: false,
            },
          ],
        });
        sidebar.invalidate();
        await settle();
        const cachedRow = sidebar.querySelector('[data-session-key="agent:main:mine"]');
        expect(cachedRow).not.toBeNull();
        const handoff = idle.mock.calls.find(([, options]) => options?.timeout === 1800)?.[0];
        expect(handoff).toBeDefined();
        const pending = createDeferred<SessionsListResult>();
        const client = context.gateway.snapshot.client!;
        const request = client.request.bind(client);
        const read = vi
          .spyOn(client, "request")
          .mockImplementation((method, params) =>
            method === "sessions.list" ? pending.promise : request(method, params),
          );

        if (selection === "refresh") {
          void sidebar.sessionData.refreshSidebarSessions();
        } else {
          sidebar.setSessionOwnerFilter(
            selection === "owner" ? other.id : null,
            selection === "involving-me",
          );
        }
        await settle();
        expect(read).toHaveBeenCalledWith(
          "sessions.list",
          expect.objectContaining(
            selection === "involving-me" ? { involvingMe: true } : { ownerId: actor.id },
          ),
        );
        handoff!({ didTimeout: false, timeRemaining: () => 10 });
        // A later shell update must not expose the stale managed window.
        sidebar.invalidate();
        await settle();
        expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBe(cachedRow);
        expect(sidebar.querySelector('[data-session-key="agent:main:replacement"]')).toBeNull();
        expect(sidebar.querySelector('[data-session-key="agent:main:stale"]')).toBeNull();

        pending.resolve({ ...sessionsResult([replacement], 2), owners: [viewer, other] });
        await settle();
        expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
        expect(
          sidebar.querySelector('[data-session-key="agent:main:replacement"]')?.textContent,
        ).toContain("Replacement session");
        expect(sidebar.sidebarSnapshot).toBeNull();
      },
    );
  },
);
