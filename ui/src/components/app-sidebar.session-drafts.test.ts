/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import {
  createModalDialogTestFixture,
  submitInputDialog,
  waitForInputDialog,
} from "../test-helpers/modal-dialog.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.tsx";

async function fixture() {
  const gateway = createGatewayHarness(createTestGatewayClient(createGatewayRequestMock()));
  const sessions = createSessionsHarness("main", ["agent:main:draft"]);
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.connected = true;
  await sidebar.updateComplete;
  return { gateway, sessions, sidebar };
}

it.each(["rename", "new group", "rename group"] as const)(
  "keeps a %s draft through same-client reconnect but retires it on identity change",
  async (kind) => {
    const { gateway, sessions, sidebar } = await fixture();
    const modal = createModalDialogTestFixture();
    const row = sidebar.findSidebarSessionByKey("agent:main:draft")!;
    const open = () =>
      modal.track(
        kind === "rename"
          ? sidebar.sessionOrganizer.renameSession(row)
          : kind === "new group"
            ? sidebar.sessionOrganizer.createSessionGroup()
            : sidebar.sessionOrganizer.renameSessionGroupFromMenu("Drafts"),
      );
    try {
      const completion = open();
      const input = await waitForInputDialog();
      input.value = "Unsent work";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const hello = gateway.gateway.snapshot.hello;
      gateway.publish({ phase: "reconnecting", hello: null });
      sidebar.connected = false;
      await sidebar.updateComplete;
      flush();

      expect(document.body.querySelector("openclaw-modal-dialog input")).toBe(input);
      expect(input.value).toBe("Unsent work");
      expect(input.disabled).toBe(false);
      expect(
        document.body.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(true);
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(sessions.patch).not.toHaveBeenCalled();
      expect(sessions.groupsPut).not.toHaveBeenCalled();
      expect(sessions.groupsRename).not.toHaveBeenCalled();

      gateway.publish({ phase: "connected", hello });
      sidebar.connected = true;
      await sidebar.updateComplete;
      await submitInputDialog("Unsent work");
      await completion;
      expect(
        kind === "rename"
          ? sessions.patch
          : kind === "new group"
            ? sessions.groupsPut
            : sessions.groupsRename,
      ).toHaveBeenCalledOnce();

      const retired = open();
      const retiredInput = await waitForInputDialog();
      retiredInput.value = "Other identity must not inherit this";
      gateway.publish({
        client: createTestGatewayClient(createGatewayRequestMock()),
        phase: "reconnecting",
        hello: null,
      });
      await retired;
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    } finally {
      await modal.cleanup();
    }
  },
);

it.each(["failed", "stale"] as const)(
  "keeps the rename dialog and typed value after a %s patch",
  async (outcome) => {
    const { gateway, sessions, sidebar } = await fixture();
    const modal = createModalDialogTestFixture();
    vi.spyOn(sessions.sessions, "patch").mockImplementationOnce(async () => {
      if (outcome === "stale") {
        gateway.publish({ phase: "reconnecting", hello: null });
        return null;
      }
      throw new Error("Rename rejected");
    });
    try {
      void modal.track(
        sidebar.sessionOrganizer.renameSession(
          sidebar.findSidebarSessionByKey("agent:main:draft")!,
        ),
      );
      await submitInputDialog("Keep this name");
      await vi.waitFor(() =>
        expect(document.body.querySelector(".exec-approval-error")).not.toBeNull(),
      );
      expect((await waitForInputDialog()).value).toBe("Keep this name");
      expect(document.body.textContent).toContain(
        outcome === "failed" ? "Rename rejected" : "Connection changed",
      );
    } finally {
      await modal.cleanup();
    }
  },
);
