/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  other,
  ownedSession,
  viewer,
  withOwnerSidebar,
} from "../test-helpers/agent-sidebar.test-support.ts";
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";

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
