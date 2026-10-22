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
  const request = createGatewayRequestMock(async (method, params) => {
    const query = isRecord(params) ? params : {};
    const { parent, child } = family;
    if (method === "sessions.list") {
      return { ...sessionsResult([parent, child], child.updatedAt ?? 1), groups: ["Projects"] };
    }
    if (method === "sessions.describe") {
      return { session: query?.key === parent.key ? parent : child };
    }
    if (method === "sessions.groups.list" || method === "sessions.groups.put") {
      return { groups: [{ name: "Projects", position: 0 }], sectionOrder: [] };
    }
    if (method === "sessions.groups.defaults") {
      return { defaults: [] };
    }
    if (method === "sessions.patch") {
      const patch = query;
      patches.push(patch);
      family.child = {
        ...child,
        ...(typeof patch.sidebarRoot === "boolean" ? { sidebarRoot: patch.sidebarRoot } : {}),
        category: typeof patch.category === "string" ? patch.category : undefined,
        updatedAt: (child.updatedAt ?? 1) + 1,
      };
      return { ok: true, key: child.key, path: "", entry: { ...family.child } };
    }
    return {};
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

function expectHistoryIdentity({
  parent,
  child,
}: Awaited<ReturnType<typeof mountFamily>>["family"]) {
  expect(child).toMatchObject({
    sessionId: "child-id",
    parentSessionKey: parent.key,
    spawnedBy: parent.key,
  });
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
        const operation = modal.track(sidebar.sessionOrganizer.createSessionGroup([row]));
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
      expectHistoryIdentity(family);
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
