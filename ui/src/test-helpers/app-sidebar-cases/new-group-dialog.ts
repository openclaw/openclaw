import { describe, expect, it, onTestFinished } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import "../../lib/toast-host.ts";
import { installDialogPolyfill, submitInputDialog, waitForInputDialog } from "../modal-dialog.ts";
import { openSubmenu, selectMenuValue } from "../session-menu.ts";
import { waitForFast } from "../wait-for.ts";
import {
  click,
  mountMultiSelect,
  openContextMenu,
  rowLink,
  sessionMenu,
} from "./multi-select-support.ts";
import "../../components/app-sidebar.tsx";

const targets = ["a", "b"].map((id) => ({
  key: `agent:main:${id}`,
  agentId: "main",
  expectedSessionId: `session:agent:main:${id}`,
}));
const dialog = () => document.body.querySelector("openclaw-modal-dialog");
const waitForClose = () => waitForFast(() => expect(dialog()).toBeNull());

async function startGroupMove(methods: string[]) {
  onTestFinished(installDialogPolyfill());
  const { sidebar, harness } = await mountMultiSelect(methods);
  let landCatalogWrite!: () => void;
  harness.groupsPut.mockReturnValueOnce(
    new Promise((resolve) => {
      landCatalogWrite = () => resolve("completed");
    }),
  );
  for (const target of targets) {
    click(rowLink(sidebar, target.key), { altKey: true });
  }
  await sidebar.updateComplete;
  openContextMenu(sidebar, targets[0]!.key);
  await sidebar.updateComplete;
  const menu = await sessionMenu(sidebar);
  await openSubmenu(menu, "Move 2 to group");
  await selectMenuValue(menu, "new-group");
  await waitForInputDialog();
  await submitInputDialog("Projects");
  await waitForFast(() => expect(harness.groupsPut).toHaveBeenCalledOnce());
  return { harness, landCatalogWrite };
}

describe("AppSidebar new group dialog", () => {
  it("moves captured sessions even when both leave the bounded list mid-write", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    onTestFinished(() => toastHost.remove());
    await toastHost.updateComplete;
    const { harness, landCatalogWrite } = await startGroupMove([
      "sessions.groups.put",
      "sessions.patchMany",
    ]);

    // Projection absence is not deletion. The Gateway can still apply both
    // captured identities, and rejects either one if it was actually removed.
    harness.publish({ result: { count: 0, sessions: [] } as unknown as SessionsListResult });
    expect(harness.patchMany).not.toHaveBeenCalled();
    landCatalogWrite();

    // Closing proves the submit continuation completed before negative assertions.
    await waitForClose();
    expect(harness.patchMany).toHaveBeenCalledWith(targets, { category: "Projects" });
    expect(harness.patch).not.toHaveBeenCalled();
    expect(toastHost.querySelector(".app-toast__message")).toBeNull();
  });

  it("reports the failed target when the Gateway moves only part of the selection", async () => {
    const { harness, landCatalogWrite } = await startGroupMove([
      "sessions.groups.put",
      "sessions.patch",
      "sessions.patchMany",
    ]);

    const failure = "Session agent:main:a changed before patch. Retry.";
    harness.patchMany.mockImplementationOnce(async (requested) => ({
      outcomes: requested.map((target) =>
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
      expect(dialog()?.querySelector("[role=alert]")?.textContent).toContain(failure),
    );
    expect(harness.patchMany).toHaveBeenCalledWith(targets, { category: "Projects" });
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.reconcileMutation).toHaveBeenCalledOnce();
    dialog()?.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    await waitForClose();
  });
});
