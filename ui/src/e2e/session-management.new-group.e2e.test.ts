import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() =>
  it("names a new group in the owned dialog instead of a browser prompt", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const nativeDialogs: string[] = [];
        page.on("dialog", (dialog) => {
          nativeDialogs.push(dialog.type());
          void dialog.dismiss();
        });
        const key = "agent:main:move-me";
        const session = sessionRow(key, "Move me", 1);
        const gateway = await ui.installSessionRows(page, [session], {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.groups.list",
            "sessions.groups.put",
            "sessions.patch",
          ],
          sessionKey: key,
        });

        async function openNewGroupDialog() {
          const row = ui.sessionRows(page)(key);
          await row.waitFor({ state: "visible", timeout: 10_000 });
          await row.hover();
          await row.click({ button: "right" });
          await support.openSessionMenuSubmenu(page, "Move to group");
          await support.activateSelfRemovingControl(ui.menuItem(page, "New group"));
          const field = page.getByLabel("New group name");
          await field.waitFor({ state: "visible" });
          return field;
        }

        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, key));
        const field = await openNewGroupDialog();
        const create = page.getByRole("button", { name: "Create group" });
        await support.captureUiProof(suite, page, "new-group-dialog-dark.png");

        expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
        await expect
          .poll(() => field.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await create.isDisabled()).toBe(true);
        await field.fill("   ");
        expect(await create.isDisabled()).toBe(true);

        await page.emulateMedia({ colorScheme: "light" });
        await support.captureUiProof(suite, page, "new-group-dialog-light.png");
        await page.emulateMedia({ colorScheme: "dark" });

        await page.setViewportSize({ height: 720, width: 420 });
        const card = page.locator("openclaw-modal-dialog .exec-approval-card");
        const bounds = await ui.bounds(card);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(ui.right(bounds)).toBeLessThanOrEqual(420);
        await support.captureUiProof(suite, page, "new-group-dialog-compact.png");
        await page.setViewportSize({ height: 900, width: 1280 });

        await page.keyboard.press("Escape");
        await field.waitFor({ state: "detached" });
        await ui.expectNoRequests(gateway, "sessions.groups.put", "sessions.patch");

        await openNewGroupDialog();
        await support.submitInputDialog(page, "  Client work  ");

        await ui.visible(page.locator('[data-session-section="category:Client work"]'));
        const putRequest = await gateway.waitForRequest("sessions.groups.put");
        expect(support.requireRecord(putRequest.params)).toMatchObject({ names: ["Client work"] });
        await ui.sessionPatch(gateway, key, { category: "Client work" });
        const categoryPatches = (await gateway.getRequests("sessions.patch")).filter(
          (request) => support.requireRecord(request.params).category === "Client work",
        );
        expect(categoryPatches).toHaveLength(1);
        expect(nativeDialogs).toEqual([]);
        await support.captureUiProof(suite, page, "new-group-created.png");
      },
      { colorScheme: "dark" },
    )),
);
