import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import { createGatewayHarness, mountSidebar, type SidebarLifecycleState } from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

const parentKey = "agent:main:parent";
const childKey = "agent:main:child";
const childSelector = `[data-session-key="${childKey}"]`;
function session(name: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: `agent:main:${name}`, sessionId: `${name}-id`, kind: "direct", ...extra };
}
function family() {
  return {
    parent: session("parent", { label: "Parent task", childSessions: [childKey] }),
    child: session("child", { parentSessionKey: parentKey }),
  };
}
async function mountArchiveSidebar(
  request: ReturnType<typeof createGatewayRequestMock>,
  active = false,
) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  if (active) {
    gateway.publish({ sessionKey: parentKey });
  }
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions);
  sidebar.connected = true;
  if (active) {
    Object.assign(sidebar, { activeRouteId: "chat", sessionKey: parentKey });
  }
  await sidebar.updateComplete;
  const query: SidebarLifecycleState["querySelector"] = sidebar.querySelector.bind(sidebar);
  return { sidebar, query };
}
function childButton(sidebar: SidebarLifecycleState) {
  return sidebar.querySelector<HTMLButtonElement>(
    `${childSelector} [data-sidebar-session-archive]`,
  )!;
}
function expectDisclosure(sidebar: SidebarLifecycleState, verb: "Show" | "Hide") {
  expect(sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-label")).toBe(
    `${verb} 1 child sessions for Parent task`,
  );
}
const waitForChild = (sidebar: SidebarLifecycleState) =>
  waitForFast(() => expect(sidebar.querySelector(childSelector)).not.toBeNull());

describe("AppSidebar child session archives", () => {
  it.each(["row", "menu"])("opens the nested archive choice from the sidebar %s", async (entry) => {
    const modal = createModalDialogTestFixture();
    const { parent, child } = family();
    const request = createGatewayRequestMock(async (method, params) => {
      const query = isRecord(params) ? params : undefined;
      if (method === "sessions.list") {
        const spawnedBy = typeof query?.spawnedBy === "string" ? query.spawnedBy : undefined;
        return sessionsResult(
          spawnedBy ? (spawnedBy === parentKey ? [child] : []) : [parent, child],
          1,
        );
      }
      if (method === "sessions.describe") {
        return { session: query?.key === parent.key ? parent : child };
      }
      return {};
    });
    const { sidebar, query } = await mountArchiveSidebar(request);
    try {
      const row = query(`[data-session-key="${parent.key}"]`)!;
      const action = entry === "row" ? "archive" : "menu";
      row.querySelector<HTMLButtonElement>(`[data-sidebar-session-${action}]`)!.click();
      if (entry === "menu") {
        await sidebar.updateComplete;
        await waitForFast(() => expect(query('[value="toggle-archived"]')).not.toBeNull());
        query('[value="toggle-archived"]')!.dispatchEvent(new Event("click", { bubbles: true }));
      }
      const actions = await waitForConfirmDialogActions();
      expect(document.body.textContent).toContain('"Parent task" has 1 directly nested session.');
      expect(actions.textContent).toContain("Archive only this session");
      expect(actions.textContent).toContain("Archive all (2)");
      answerConfirmDialog(actions, "cancel");
      await vi.dynamicImportSettled();
      const methods = request.mock.calls.map(([method]) => method);
      expect(methods).not.toContain("sessions.patch");
      expect(methods).not.toContain("sessions.patchMany");
    } finally {
      sidebar.remove();
      await modal.cleanup();
    }
  });

  it("updates child disclosure after archive and restore", async () => {
    const { parent, child } = family();
    parent.updatedAt = 1;
    child.updatedAt = 2;
    let archived = false;
    let revision = 2;
    const request = createGatewayRequestMock(async (method, params) => {
      const query = isRecord(params) ? params : undefined;
      if (method === "sessions.list") {
        const currentChild = { ...child, archived, updatedAt: revision };
        const roots = archived && query?.archived !== "all" ? [parent] : [parent, currentChild];
        return sessionsResult(
          query?.spawnedBy === parentKey ? (archived ? [] : [currentChild]) : roots,
          revision,
        );
      }
      if (method === "sessions.patch") {
        expect(query).toMatchObject({ key: childKey });
        archived = query?.archived === true;
        revision += 1;
        return {
          ok: true,
          key: childKey,
          path: "",
          entry: {
            sessionId: child.sessionId,
            updatedAt: revision,
            ...(archived ? { archivedAt: revision } : {}),
          },
        };
      }
      if (method === "sessions.describe") {
        return {
          session: query?.key === parentKey ? parent : { ...child, archived, updatedAt: revision },
        };
      }
      return {};
    });
    const { sidebar, query } = await mountArchiveSidebar(request, true);
    const toggle = query<HTMLButtonElement>("[data-child-session-toggle]");
    expectDisclosure(sidebar, "Show");
    toggle!.click();

    await waitForChild(sidebar);
    const archiveSession = vi.spyOn(sidebar.sessionOrganizer, "archiveSessionWithUndo");
    childButton(sidebar).click();
    // Await the organizer's mutation and reconciliation, not just rendering.
    await archiveSession.mock.results[0]!.value;
    await sidebar.updateComplete;
    expect(query("[data-child-session-toggle]")).toBeNull();
    expect(query(childSelector)).toBeNull();
    await activateSessionMenuValue(sidebar, "status:all");
    await waitForChild(sidebar);
    expectDisclosure(sidebar, "Hide");
    const restoreSession = vi.spyOn(sidebar.sessionOrganizer, "patchSession");
    childButton(sidebar).click();
    expect(restoreSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: childKey, sessionId: child.sessionId }),
      { archived: false },
      { sessionScope: true },
    );
    await expect(restoreSession.mock.results[0]!.value).resolves.toBe("completed");
    await activateSessionMenuValue(sidebar, "status:active");
    await waitForChild(sidebar);
    expectDisclosure(sidebar, "Hide");
  });
});
