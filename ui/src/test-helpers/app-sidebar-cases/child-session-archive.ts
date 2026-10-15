import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import { createGatewayHarness, mountSidebar } from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import {
  answerConfirmDialog,
  createModalDialogTestFixture,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar child session archives", () => {
  it.each(["row", "menu"])("opens the nested archive choice from the sidebar %s", async (entry) => {
    const modal = createModalDialogTestFixture();
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      sessionId: "parent-id",
      kind: "direct",
      label: "Parent task",
      childSessions: ["agent:main:child"],
    };
    const child: GatewaySessionRow = {
      key: "agent:main:child",
      sessionId: "child-id",
      kind: "direct",
      label: "Child task",
      parentSessionKey: parent.key,
    };
    const request = createGatewayRequestMock(async (method, params) => {
      const query = isRecord(params) ? params : undefined;
      if (method === "sessions.list") {
        return sessionsResult(
          query?.spawnedBy === parent.key ? [child] : query?.spawnedBy ? [] : [parent, child],
          1,
        );
      }
      if (method === "sessions.describe") {
        return { session: query?.key === parent.key ? parent : child };
      }
      return {};
    });
    const gateway = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    try {
      const row = sidebar.querySelector(`[data-session-key="${parent.key}"]`)!;
      if (entry === "row") {
        row.querySelector<HTMLButtonElement>("[data-sidebar-session-archive]")!.click();
      } else {
        row.querySelector<HTMLButtonElement>("[data-sidebar-session-menu]")!.click();
        await sidebar.updateComplete;
        await waitForFast(() =>
          expect(sidebar.querySelector('[value="toggle-archived"]')).not.toBeNull(),
        );
        sidebar
          .querySelector('[value="toggle-archived"]')!
          .dispatchEvent(new Event("click", { bubbles: true }));
      }
      const actions = await waitForConfirmDialogActions();
      expect(document.body.textContent).toContain('"Parent task" has a nested session.');
      expect(actions.textContent).toContain("Archive this session");
      expect(actions.textContent).toContain("Archive 2 sessions");
      answerConfirmDialog(actions, "cancel");
      await vi.dynamicImportSettled();
      expect(
        request.mock.calls.some(
          ([method]) => method === "sessions.patch" || method === "sessions.patchMany",
        ),
      ).toBe(false);
    } finally {
      sidebar.remove();
      await modal.cleanup();
    }
  });

  it.each([{ scenario: "archive", coldLoad: false, unrelated: false }])(
    "updates child disclosure after $scenario",
    async ({ coldLoad, unrelated }) => {
      const parentKey = "agent:main:parent";
      const childKey = "agent:main:child";
      const parent: GatewaySessionRow = {
        key: parentKey,
        sessionId: "parent-id",
        kind: "direct",
        label: "Parent task",
        updatedAt: 1,
        childSessions: [childKey],
      };
      const child: GatewaySessionRow = {
        key: childKey,
        sessionId: "child-id",
        ...(unrelated ? {} : { parentSessionKey: parentKey }),
        kind: "direct",
        label: "Child task",
        updatedAt: 2,
      };
      let archived = coldLoad && !unrelated;
      let revision = 2;
      const request = createGatewayRequestMock(async (method, params) => {
        const query = isRecord(params) ? params : undefined;
        if (method === "sessions.list") {
          const currentChild = { ...child, archived, updatedAt: revision };
          return sessionsResult(
            query?.spawnedBy === parentKey
              ? archived || unrelated
                ? []
                : [currentChild]
              : archived && query?.archived !== "all"
                ? [parent]
                : [parent, currentChild],
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
            session:
              query?.key === parentKey ? parent : { ...child, archived, updatedAt: revision },
          };
        }
        return {};
      });
      const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
      gatewayHarness.publish({ sessionKey: parentKey });
      const sessions = createTestSessionCapability(gatewayHarness.gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions);
      sidebar.connected = true;
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = parentKey;
      await sidebar.updateComplete;
      const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
      expect(toggle?.getAttribute("aria-label")).toBe("Show 1 child sessions for Parent task");
      toggle!.click();
      if (coldLoad) {
        await waitForFast(() =>
          expect(sidebar.sessionData.loadedChildSessionKeys.has(parentKey)).toBe(true),
        );
        expect(sessions.archiveVisibility(childKey)).toBeUndefined();
      } else {
        await waitForFast(() =>
          expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
        );
        const archive = sidebar.querySelector<HTMLButtonElement>(
          `[data-session-key="${childKey}"] [data-sidebar-session-archive]`,
        );
        expect(archive?.disabled).toBe(false);
        const archiveSession = vi.spyOn(sidebar.sessionOrganizer, "archiveSessionWithUndo");
        archive!.click();
        expect(archiveSession).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ key: childKey, sessionId: child.sessionId }),
        );
        // The organizer owns the lazy import, mutation, and reconciliation. A rendered
        // button does not mean that lifecycle has completed within a polling window.
        await archiveSession.mock.results[0]!.value;
        expect(sessions.archiveVisibility(childKey)).toBe("archived");
      }
      await sidebar.updateComplete;
      expect(sidebar.querySelector("[data-child-session-toggle]")).toBeNull();
      if (unrelated) {
        expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull();
        expect(
          sidebar.querySelector(
            `[data-session-tree="${parentKey}"] [data-session-key="${childKey}"]`,
          ),
        ).toBeNull();
        return;
      }
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
      const selectStatus = (value: string) => activateSessionMenuValue(sidebar, value);
      await selectStatus("status:all");
      await waitForFast(() =>
        expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
      );
      expect(sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-label")).toBe(
        "Hide 1 child sessions for Parent task",
      );
      const restoreSession = vi.spyOn(sidebar.sessionOrganizer, "patchSession");
      sidebar
        .querySelector<HTMLButtonElement>(
          `[data-session-key="${childKey}"] [data-sidebar-session-archive]`,
        )!
        .click();
      expect(restoreSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ key: childKey, sessionId: child.sessionId }),
        { archived: false },
        { sessionScope: true },
      );
      await expect(restoreSession.mock.results[0]!.value).resolves.toBe("completed");
      expect(archived).toBe(false);
      await selectStatus("status:active");
      await waitForFast(() =>
        expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
      );
      expect(sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-label")).toBe(
        "Hide 1 child sessions for Parent task",
      );
    },
  );
});
