/* @vitest-environment jsdom */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createGatewayHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { createModalDialogTestFixture, submitInputDialog } from "../test-helpers/modal-dialog.ts";
import { createSessionGroup } from "./session-organizer-menu.runtime.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.tsx";

async function mountFamily() {
  const row = (id: string, updatedAt: number, extra: Partial<GatewaySessionRow>) => ({
    key: `agent:main:${id}`,
    sessionId: `${id}-id`,
    kind: "direct" as const,
    updatedAt,
    ...extra,
  });
  const family: { parent: GatewaySessionRow; child: GatewaySessionRow } = {
    parent: row("parent", 1, {
      label: "Archived parent",
      childSessions: ["agent:main:child"],
      archived: true,
    }),
    child: row("child", 2, {
      label: "Surviving child",
      parentSessionKey: "agent:main:parent",
      spawnedBy: "agent:main:parent",
    }),
  };
  const patches: Record<string, unknown>[] = [];
  const request = createGatewayRequestMock(async (method, raw) => {
    const params = isRecord(raw) ? raw : {};
    const { parent, child } = family;
    if (method === "sessions.list") {
      return { ...sessionsResult([parent, child], child.updatedAt ?? 1), groups: ["Projects"] };
    }
    if (method === "sessions.describe") {
      return { session: params.key === parent.key ? parent : child };
    }
    if (method === "sessions.groups.list" || method === "sessions.groups.put") {
      return { groups: [{ name: "Projects", position: 0 }], sectionOrder: [] };
    }
    if (method === "sessions.patch") {
      patches.push(params);
      family.child = {
        ...child,
        ...(typeof params.sidebarRoot === "boolean" ? { sidebarRoot: params.sidebarRoot } : {}),
        category: typeof params.category === "string" ? params.category : undefined,
        updatedAt: (child.updatedAt ?? 1) + 1,
      };
      return { ok: true, key: child.key, path: "", entry: { ...family.child } };
    }
    return method === "sessions.groups.defaults" ? { defaults: [] } : {};
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  const sessionKey = family.child.key;
  gateway.publish({ sessionKey });
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  await sessions.groupsLoad();
  const { sidebar } = await mountSidebar(gateway.gateway, sessions);
  sidebar.connected = true;
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = sessionKey;
  await sidebar.updateComplete;
  return { sidebar, sessions, family, patches };
}

it.each(["existing group", "new group"])(
  "keeps an archived parent's child independent after moving to a %s",
  async (action) => {
    const { sidebar, sessions, family, patches } = await mountFamily();
    const modal = createModalDialogTestFixture();
    try {
      const row = sidebar.findSidebarSessionByKey(family.child.key)!;
      expect(row).toMatchObject({ isChild: false, pinnable: false });
      if (action === "existing group") {
        await sidebar.sessionOrganizer.assignSessionCategory(row, "Projects");
      } else {
        const operation = modal.track(createSessionGroup(sidebar.sessionOrganizer, [row]));
        await submitInputDialog("Projects");
        await operation;
      }
      expect(patches).toEqual([
        expect.objectContaining({ category: "Projects", sidebarRoot: true }),
      ]);
      family.parent = { ...family.parent, archived: false, updatedAt: 10 };
      family.child = { ...family.child, category: undefined, updatedAt: 11 };
      await sessions.refresh({ agentId: "main", force: true });
      await sidebar.updateComplete;
      expect(sidebar.findSidebarSessionByKey(family.child.key)).toMatchObject({
        isChild: false,
        sidebarRoot: true,
      });
      expect(family.child).toMatchObject({
        sessionId: "child-id",
        parentSessionKey: family.parent.key,
        spawnedBy: family.parent.key,
      });
      sidebar.sidebarEntries = [];
      sidebar.onUpdateSidebarEntries = (entries) => {
        sidebar.sidebarEntries = entries;
      };
      sidebar
        .querySelector<HTMLButtonElement>(
          `[data-session-key="${family.child.key}"] [data-sidebar-session-pin]`,
        )!
        .click();
      await sidebar.updateComplete;
      expect(sidebar.sidebarEntries).toEqual([`session:${family.child.key}`]);
      expect(patches).toHaveLength(1);
    } finally {
      await modal.cleanup();
    }
  },
);

it("moves a demoted saved child out of Pinned without forgetting its pin", async () => {
  const { sidebar, sessions, family } = await mountFamily();
  const key = family.child.key;
  sidebar.sidebarEntries = [`session:${key}`];
  const placementsAfter = async (sidebarRoot: boolean) => {
    await sessions.patch(key, { sidebarRoot });
    await sidebar.updateComplete;
    return [...sidebar.querySelectorAll(`.sidebar-recent-session[data-session-key="${key}"]`)].map(
      (row) => row.closest<HTMLElement>("[data-session-section]")?.dataset.sessionSection,
    );
  };
  expect(await placementsAfter(true)).toEqual(["pinned"]);
  expect(await placementsAfter(false)).toEqual(["ungrouped"]);
  expect(await placementsAfter(true)).toEqual(["pinned"]);
});
