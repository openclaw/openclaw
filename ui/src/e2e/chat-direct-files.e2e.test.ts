import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Direct composer file browsing" });

// Browser API fixture only: production menu, draft admission, FileReader,
// attachment cards, and explicit send run unchanged. This cannot certify OS menus.
suite.define(() => {
  it.each(["chat", "new"])(
    "stages unrestricted documents and sends only on request in %s",
    (route) =>
      suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.addInitScript(() => {
          let count = 0;
          Object.defineProperty(window, "showOpenFilePicker", {
            configurable: true,
            value: async (options: unknown) => {
              if (!navigator.userActivation.isActive) {
                throw new DOMException("Picker lost user activation", "SecurityError");
              }
              if (JSON.stringify(options) !== JSON.stringify({ multiple: true })) {
                throw new Error("Unexpected filtering or single-selection restriction");
              }
              count += 1;
              if (count === 2) {
                throw new DOMException("Cancelled", "AbortError");
              }
              const files = [
                new File(["solid synthetic"], "part.stl"),
                new File(["synthetic document"], "notes.unlisted-extension"),
              ];
              return files.map((file) => ({ getFile: async () => file }));
            },
          });
        });
        const gateway = await installMockGateway(page, { historyMessages: [] });
        let inputChoosers = 0;
        page.on("filechooser", () => {
          inputChoosers += 1;
        });
        await page.goto(suite.server.baseUrl + route);
        const editor = page
          .locator(".agent-chat__composer-combobox textarea, .new-session-page__composer textarea")
          .first();
        await editor.fill("Keep this synthetic document draft.");
        const select = async () => {
          await page.getByRole("button", { name: "Add attachment", exact: true }).click();
          const item = page.locator('.agent-chat__attach-menu-option[data-value="file"]');
          await item.waitFor({ state: "visible" });
          await item.click();
        };
        await select();
        const ready = page.locator('.chat-attachment-thumb[aria-busy="false"]');
        await expect.poll(() => ready.count()).toBe(2);
        expect(inputChoosers).toBe(0);
        await select();
        expect(await editor.inputValue()).toBe("Keep this synthetic document draft.");
        expect(await ready.count()).toBe(2);
        await page.getByRole("button", { name: "Remove part.stl", exact: true }).click();
        await page
          .getByRole("button", { name: "Remove notes.unlisted-extension", exact: true })
          .click();
        await select();
        await expect.poll(() => ready.count()).toBe(2);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        expect(await gateway.getRequests("sessions.create")).toEqual([]);
        const method = route === "chat" ? "chat.send" : "sessions.create";
        await page
          .getByRole("button", {
            name: route === "chat" ? "Send message" : "Start session",
            exact: true,
          })
          .click();
        const request = await gateway.waitForRequest(method);
        expect(request.params).toMatchObject({
          attachments: [
            {
              fileName: "part.stl",
              mimeType: "application/octet-stream",
              content: Buffer.from("solid synthetic").toString("base64"),
            },
            {
              fileName: "notes.unlisted-extension",
              mimeType: "application/octet-stream",
              content: Buffer.from("synthetic document").toString("base64"),
            },
          ],
        });
      }),
  );
});
