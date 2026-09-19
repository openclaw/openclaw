import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Responsive attachment menu" });

suite.define(() => {
  it.each(["chat", "new"])(
    "uses one native attachment chooser in the mobile %s composer",
    async (route) => {
      await suite.withPage(
        { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
        async ({ page }) => {
          await installMockGateway(page, { historyMessages: [] });
          await page.goto(suite.server.baseUrl + route);
          const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
          await trigger.click();
          const items = page.locator(".agent-chat__attach-menu-option:visible");
          await expect
            .poll(async () => (await items.allTextContents()).map((text) => text.trim()))
            .toEqual(["Attach…"]);
          for (const value of ["open-skills", "open-connectors", "manage-plugins"]) {
            expect(await page.locator(`wa-dropdown-item[value="${value}"]`).isVisible()).toBe(true);
          }
          const chooserPromise = page.waitForEvent("filechooser");
          await items.click();
          const chooser = await chooserPromise;
          expect(chooser.isMultiple()).toBe(true);
          expect(await chooser.element().getAttribute("class")).toBe("agent-chat__file-input");
          expect(await chooser.element().getAttribute("capture")).toBeNull();
          expect(await chooser.element().getAttribute("accept")).toContain("application/pdf");
          // Empty selection models cancellation at the input boundary, not a native OS dialog.
          await chooser.setFiles([]);
          expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
          const file = {
            name: "note.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Synthetic attachment"),
          };
          await trigger.click();
          const selected = page.waitForEvent("filechooser");
          await items.click();
          await (await selected).setFiles([file, { ...file, name: "second.txt" }]);
          await expect
            .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
            .toBe(2);
          await page.getByRole("button", { name: "Remove note.txt", exact: true }).click();
          await trigger.click();
          const reselected = page.waitForEvent("filechooser");
          await items.click();
          await (await reselected).setFiles(file);
          await expect
            .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
            .toBe(2);

          // Layout, not touch hardware or a user-agent guess, owns the menu choice.
          for (const [width, height, single] of [
            [1024, 768, false],
            [820, 1180, true],
            [932, 430, true],
            [1280, 900, false],
          ] as const) {
            await page.setViewportSize({ width, height });
            await trigger.click();
            await expect.poll(() => items.count()).toBe(single ? 1 : 3);
            if (!single) {
              await expect
                .poll(async () => (await items.allTextContents()).map((text) => text.trim()))
                .toEqual(["Take photo", "Photo", "File"]);
            }
            await page.keyboard.press("Escape");
          }
        },
      );
    },
  );
});
