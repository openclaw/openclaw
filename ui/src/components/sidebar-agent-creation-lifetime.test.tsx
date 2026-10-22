/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGateway,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";

const upload = vi.hoisted(() => vi.fn());
vi.mock("../pages/agents/avatar-image.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/agents/avatar-image.ts")>()),
  fileToAvatarDataUrl: upload,
}));
setupSidebarTest();
let restoreDialog: () => void;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  upload.mockReset();
});
afterEach(() => restoreDialog());

it.each(["cancel button", "modal cancel", "owner close"])(
  "opens a usable successor after %s while avatar conversion is pending",
  async (close) => {
    const pending = createDeferred<{ ok: false; reason: "unusable" }>();
    upload.mockReturnValueOnce(pending.promise);
    const { sidebar } = await mountSidebar(
      createGateway(createTestGatewayClient(async () => ({}))),
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const menus = getAppSidebarOwner(sidebar.hostElement)!.sidebarMenus;
    const dialog = () => document.querySelector<HTMLElement>("openclaw-modal-dialog");
    const name = () => dialog()!.querySelector<HTMLInputElement>('input[name="name"]')!;
    menus.openAgentCreateDialog();
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(name()).toBeTruthy());
    const old = dialog()!;
    [...old.querySelectorAll<HTMLButtonElement>(".avatar-picker__tabs button")]
      .find((button) => button.textContent?.trim() === "Upload")!
      .click();
    flush();
    const file = old.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", {
      value: [new File(["image"], "avatar.png", { type: "image/png" })],
    });
    file.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(old.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    try {
      if (close === "owner close") {
        menus.closeAgentCreateDialog();
      } else if (close === "modal cancel") {
        old.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      } else {
        old.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
      }
      await waitForSolid(() => expect(old.isConnected).toBe(false));
      menus.openAgentCreateDialog();
      await waitForSolid(() => {
        expect(dialog()).not.toBeNull();
        expect(dialog()).not.toBe(old);
      });
      const successor = name();
      successor.value = "New draft";
      successor.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(successor.disabled).toBe(false);
      pending.resolve({ ok: false, reason: "unusable" });
      await pending.promise;
      await waitForSolid(() => {
        expect(name()).toBe(successor);
        expect(successor.value).toBe("New draft");
        expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
      });
    } finally {
      pending.resolve({ ok: false, reason: "unusable" });
      menus.closeAgentCreateDialog();
    }
  },
);
