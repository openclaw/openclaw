import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowserFixtures,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Platform attachment menu" });

async function choose(page: Page, kind: string) {
  await page.getByRole("button", { name: "Add attachment", exact: true }).press("Enter");
  const pending = page.waitForEvent("filechooser");
  await page.locator(`.agent-chat__attach-menu-option[value="${kind}"]`).press("Enter");
  return pending;
}

suite.define(() => {
  for (const route of ["chat", "new"]) {
    it.each(attachmentBrowserFixtures)(
      `preserves $name picker semantics in ${route} across widths`,
      async (fixture) => {
        await suite.withPage(
          {
            userAgent: fixture.userAgent,
            hasTouch: fixture.touch > 0,
            viewport: { width: 390, height: 844 },
          },
          async ({ page }) => {
            await installAttachmentBrowserIdentity(page, fixture);
            await installMockGateway(page, { historyMessages: [] });
            await page.goto(suite.server.baseUrl + route);
            const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
            const items = page.locator(".agent-chat__attach-menu-option:visible");
            for (const [width, height] of [
              [390, 844],
              [1024, 768],
              [820, 1180],
              [932, 430],
            ] as const) {
              await page.setViewportSize({ width, height });
              await trigger.press("Enter");
              await page
                .locator('.agent-chat__attach-menu-option[value="file"]')
                .waitFor({ state: "visible" });
              expect((await items.allTextContents()).map((text) => text.trim())).toEqual(
                fixture.single ? ["Attach…"] : ["Take photo", "Photo", "File"],
              );
              for (const value of ["open-skills", "open-connectors", "manage-plugins"]) {
                expect(await page.locator(`wa-dropdown-item[value="${value}"]`).isVisible()).toBe(
                  true,
                );
              }
              await page.keyboard.press("Escape");
            }
            for (const kind of fixture.single ? ["file"] : ["file", "photo", "camera"]) {
              const chooser = await choose(page, kind);
              expect(await chooser.element().getAttribute("class")).toBe(
                `agent-chat__${kind}-input`,
              );
              expect(chooser.isMultiple()).toBe(kind !== "camera");
              expect(await chooser.element().getAttribute("capture")).toBe(
                kind === "camera" ? "environment" : null,
              );
              const accept = await chooser.element().getAttribute("accept");
              if (kind === "file") {
                for (const type of [
                  "image/*",
                  "video/*",
                  "audio/*",
                  "application/pdf",
                  ".docx",
                  ".zip",
                ]) {
                  expect(accept).toContain(type);
                }
              } else {
                expect(accept).toBe("image/*");
              }
              // Boundary-only cancellation: Playwright does not exercise OS dialogs.
              await chooser.setFiles([]);
              expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
            }
          },
        );
      },
    );

    it(`multiselects and reselects through Attach in ${route}`, async () => {
      const [fixture] = attachmentBrowserFixtures;
      if (!fixture) {
        throw new Error("Missing iPhone attachment fixture");
      }
      await suite.withPage(
        { userAgent: fixture.userAgent, hasTouch: true, viewport: { width: 390, height: 844 } },
        async ({ page }) => {
          await installAttachmentBrowserIdentity(page, fixture);
          await installMockGateway(page, { historyMessages: [] });
          await page.goto(suite.server.baseUrl + route);
          const file = {
            name: "note.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Synthetic attachment"),
          };
          await (await choose(page, "file")).setFiles([file, { ...file, name: "second.txt" }]);
          const ready = page.locator('.chat-attachment-thumb[aria-busy="false"]');
          await expect.poll(() => ready.count()).toBe(2);
          await page.getByRole("button", { name: "Remove note.txt", exact: true }).click();
          await (await choose(page, "file")).setFiles(file);
          await expect.poll(() => ready.count()).toBe(2);
          expect(await page.locator(".agent-chat__file-input").inputValue()).toBe("");
        },
      );
    });
  }
});
