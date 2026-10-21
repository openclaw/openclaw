import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionsListResult } from "../../api/types.ts";
import "../../lib/toast-host.ts";
import type { SessionGroupMutationResult } from "../app-sidebar.ts";
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
  const write = createDeferred<SessionGroupMutationResult>();
  harness.groupsPut.mockReturnValueOnce(write.promise);
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
  return { harness, landCatalogWrite: () => write.resolve("completed") };
}

describe("AppSidebar new group dialog", () => {
  it.each([false, true])(
    "moves captured identities after list eviction (partial failure: %s)",
    async (partial) => {
      const toast = partial ? null : document.createElement("openclaw-toast-host");
      if (toast) {
        document.body.append(toast);
        onTestFinished(() => toast.remove());
        await toast.updateComplete;
      }
      const methods = ["sessions.groups.put", "sessions.patchMany"];
      if (partial) {
        methods.splice(1, 0, "sessions.patch");
      }
      const { harness, landCatalogWrite } = await startGroupMove(methods);
      const failure = "Session agent:main:a changed before patch. Retry.";
      if (partial) {
        harness.patchMany.mockImplementationOnce(async (requested) => ({
          outcomes: requested.map((target) =>
            target.key === "agent:main:a"
              ? { ok: false, ...target, error: { code: "INVALID_REQUEST", message: failure } }
              : { ok: true, ...target },
          ),
        }));
      }
      // Projection absence is not deletion: both captured identities must reach the Gateway.
      const visible = partial
        ? [{ key: "agent:main:b", sessionId: "session:agent:main:b", agentId: "main" }]
        : [];
      harness.publish({
        result: { count: visible.length, sessions: visible } as unknown as SessionsListResult,
      });
      if (!partial) {
        expect(harness.patchMany).not.toHaveBeenCalled();
      }
      landCatalogWrite();
      if (partial) {
        await waitForFast(() =>
          expect(dialog()?.querySelector("[role=alert]")?.textContent).toContain(failure),
        );
      } else {
        // Closing proves the submit continuation completed before negative assertions.
        await waitForClose();
      }
      expect(harness.patchMany).toHaveBeenCalledWith(targets, { category: "Projects" });
      expect(harness.patch).not.toHaveBeenCalled();
      if (partial) {
        expect(harness.reconcileMutation).toHaveBeenCalledOnce();
        dialog()?.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
        await waitForClose();
      } else {
        expect(toast!.querySelector(".app-toast__message")).toBeNull();
      }
    },
  );
});
