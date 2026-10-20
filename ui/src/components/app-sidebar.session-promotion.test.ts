/* @vitest-environment jsdom */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createGatewayHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { createModalDialogTestFixture, submitInputDialog } from "../test-helpers/modal-dialog.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.tsx";

function drag(
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransferStub>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

async function mountFamily(archived = false) {
  const family: { parent: GatewaySessionRow; child: GatewaySessionRow } = {
    parent: {
      key: "agent:main:parent",
      sessionId: "parent-id",
      kind: "direct",
      label: archived ? "Archived parent" : "Public thread access",
      updatedAt: 1,
      childSessions: ["agent:main:child"],
      ...(archived ? { archived: true } : {}),
    },
    child: {
      key: "agent:main:child",
      sessionId: "child-id",
      kind: "direct",
      label: archived ? "Surviving child" : "Reconcile short URLs",
      updatedAt: 2,
      parentSessionKey: "agent:main:parent",
      spawnedBy: "agent:main:parent",
    },
  };
  const patches: Record<string, unknown>[] = [];
  const request = createGatewayRequestMock(async (method, params) => {
    const query = isRecord(params) ? params : {};
    const { parent, child } = family;
    if (method === "sessions.list") {
      const result = sessionsResult(
        !archived && query.spawnedBy === parent.key ? [child] : [parent, child],
        child.updatedAt ?? 1,
      );
      return archived ? { ...result, groups: ["Projects"] } : result;
    }
    if (method === "sessions.describe") {
      return { session: query?.key === parent.key ? parent : child };
    }
    if (method === "sessions.patch" || (archived && method === "sessions.patchMany")) {
      const patch = method === "sessions.patch" ? query : isRecord(query.patch) ? query.patch : {};
      patches.push(patch);
      if (!archived) {
        expect(query).toMatchObject({
          key: child.key,
          expectedSessionId: child.sessionId,
          sidebarRoot: true,
        });
      }
      family.child = {
        ...child,
        ...(typeof patch.sidebarRoot === "boolean" ? { sidebarRoot: patch.sidebarRoot } : {}),
        ...(archived
          ? { category: typeof patch.category === "string" ? patch.category : undefined }
          : {}),
        updatedAt: (child.updatedAt ?? 1) + 1,
      };
      return method === "sessions.patch"
        ? { ok: true, key: child.key, path: "", entry: { ...family.child } }
        : { outcomes: [{ ok: true, key: child.key, agentId: "main" }] };
    }
    return {};
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  const sessionKey = archived ? family.child.key : family.parent.key;
  gateway.publish({ sessionKey });
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions);
  sidebar.connected = true;
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = sessionKey;
  if (archived) {
    await sidebar.updateComplete;
  }
  return { sidebar, sessions, request, family, patches };
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

it("drags a nested conversation into the top level and keeps its history identity", async () => {
  const { sidebar, request, family } = await mountFamily();
  sidebar.sidebarEntries = [];
  sidebar.onUpdateSidebarEntries = (entries) => {
    sidebar.sidebarEntries = entries;
  };
  await sidebar.updateComplete;
  sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
  await waitForFast(() =>
    expect(sidebar.querySelector(".sidebar-recent-session--child")).not.toBeNull(),
  );
  const row = sidebar.querySelector<HTMLElement>(".sidebar-recent-session--child")!;
  expect(row.getAttribute("draggable")).toBe("true");
  const shortcutDrop = createDataTransferStub();
  drag(row, "dragstart", shortcutDrop);
  drag(sidebar.querySelector(".sidebar-rail__pins")!, "drop", shortcutDrop);
  expect(family.child.sidebarRoot).toBeUndefined();
  expect(sidebar.sidebarEntries).toEqual([]);
  expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(0);
  const data = createDataTransferStub();
  drag(row, "dragstart", data);
  await sidebar.updateComplete;
  const drop = sidebar.querySelector("[data-session-root-drop]");
  expect(drop?.textContent).toContain("Move to top level");
  drag(drop!, "dragover", data);
  drag(drop!, "drop", data);
  await waitForFast(() => expect(family.child.sidebarRoot).toBe(true));
  await waitForFast(() =>
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:child"]')
        ?.classList.contains("sidebar-recent-session--child"),
    ).toBe(false),
  );
  expectHistoryIdentity(family);
  sidebar
    .querySelector<HTMLButtonElement>(
      '[data-session-key="agent:main:child"] [data-sidebar-session-pin]',
    )!
    .click();
  await sidebar.updateComplete;
  expect(sidebar.sidebarEntries).toEqual(["session:agent:main:child"]);
  expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
});

it.each(["existing group", "new group", "batch group"])(
  "keeps an archived parent's child independent after moving to a %s",
  async (action) => {
    const { sidebar, sessions, family, patches } = await mountFamily(true);
    const modal = createModalDialogTestFixture();
    try {
      const row = sidebar.findSidebarSessionByKey(family.child.key)!;
      expect(row).toMatchObject({ isChild: false, pinnable: false });
      if (action === "existing group") {
        await sidebar.sessionOrganizer.assignSessionCategory(row, "Projects");
      } else if (action === "new group") {
        const operation = modal.track(sidebar.sessionOrganizer.createSessionGroup([row]));
        await submitInputDialog("Projects");
        await operation;
      } else {
        await sidebar.sessionOrganizer.runBatchSessionAction(
          { kind: "move-to-group", category: "Projects" },
          [row],
          false,
        );
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
    } finally {
      await modal.cleanup();
    }
  },
);
