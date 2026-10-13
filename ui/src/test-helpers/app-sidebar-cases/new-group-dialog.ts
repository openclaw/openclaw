import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { installDialogPolyfill, submitInputDialog, waitForInputDialog } from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";
import {
  click,
  mountMultiSelect,
  openContextMenu,
  rowLink,
  sessionMenu,
} from "./multi-select-support.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar new group dialog", () => {
  it("moves captured sessions even when both leave the bounded list mid-write", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patchMany",
      ]);
      let landCatalogWrite!: () => void;
      harness.groupsPut.mockReturnValueOnce(
        new Promise((resolve) => {
          landCatalogWrite = () => resolve("completed");
        }),
      );
      click(rowLink(sidebar, "agent:main:a"), { altKey: true });
      click(rowLink(sidebar, "agent:main:b"), { altKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      // Projection absence is not deletion. The Gateway can still apply both
      // captured identities, and rejects either one if it was actually removed.
      harness.publish({ result: { count: 0, sessions: [] } as unknown as SessionsListResult });
      expect(harness.patchMany).not.toHaveBeenCalled();
      landCatalogWrite();

      // The dialog is removed only once the submit chain has run to completion,
      // so waiting on that keeps the negative assertions below from passing
      // before the continuation has had a chance to patch anything.
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          { key: "agent:main:a", agentId: "main", expectedSessionId: "session:agent:main:a" },
          { key: "agent:main:b", agentId: "main", expectedSessionId: "session:agent:main:b" },
        ],
        { category: "Projects" },
      );
      expect(harness.patch).not.toHaveBeenCalled();
      expect(toastHost.querySelector(".app-toast__message")).toBeNull();
    } finally {
      toastHost.remove();
      restoreDialogPolyfill();
    }
  });

  it("reports the failed target when the Gateway moves only part of the selection", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const { sidebar, harness } = await mountMultiSelect([
        "sessions.groups.put",
        "sessions.patch",
        "sessions.patchMany",
      ]);
      let landCatalogWrite!: () => void;
      harness.groupsPut.mockReturnValueOnce(
        new Promise((resolve) => {
          landCatalogWrite = () => resolve("completed");
        }),
      );
      click(rowLink(sidebar, "agent:main:a"), { altKey: true });
      click(rowLink(sidebar, "agent:main:b"), { altKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:a");
      await sidebar.updateComplete;
      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLElement>('wa-dropdown-item[value="new-group"]')?.click();

      await waitForInputDialog();
      await submitInputDialog("Projects");
      await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());

      const failure = "Session agent:main:a changed before patch. Retry.";
      harness.patchMany.mockImplementationOnce(async (targets) => ({
        outcomes: targets.map((target) =>
          target.key === "agent:main:a"
            ? { ok: false, ...target, error: { code: "INVALID_REQUEST", message: failure } }
            : { ok: true, ...target },
        ),
      }));
      harness.publish({
        result: {
          count: 1,
          sessions: [{ key: "agent:main:b", sessionId: "session:agent:main:b", agentId: "main" }],
        } as unknown as SessionsListResult,
      });
      landCatalogWrite();

      await waitForFast(() =>
        expect(
          document.body.querySelector("openclaw-modal-dialog [role=alert]")?.textContent,
        ).toContain(failure),
      );
      expect(harness.patchMany).toHaveBeenCalledWith(
        [
          { key: "agent:main:a", agentId: "main", expectedSessionId: "session:agent:main:a" },
          { key: "agent:main:b", agentId: "main", expectedSessionId: "session:agent:main:b" },
        ],
        { category: "Projects" },
      );
      expect(harness.patch).not.toHaveBeenCalled();
      expect(harness.reconcileMutation).toHaveBeenCalledOnce();
      document.body
        .querySelector<HTMLButtonElement>('openclaw-modal-dialog button[type="button"]')
        ?.click();
      await waitForFast(() =>
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
      );
    } finally {
      restoreDialogPolyfill();
    }
  });
});
