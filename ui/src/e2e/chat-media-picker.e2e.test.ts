import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowser,
  attachmentImage,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Existing photos and videos" });
const image = attachmentImage("synthetic.png");
const video = {
  name: "synthetic.mp4",
  mimeType: "video/mp4",
  buffer: readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url)),
};

suite.define(() => {
  it.each([
    { browser: "iOS Chrome", route: "chat" },
    { browser: "iPhone Safari", route: "new" },
    { browser: "Android Chrome", route: "new" },
  ])(
    "selects mixed existing media and preserves the $route draft on $browser",
    ({ browser, route }) =>
      suite.withPage(
        {
          viewport: { width: attachmentBrowser(browser).touch ? 390 : 1280, height: 844 },
          userAgent: attachmentBrowser(browser).userAgent,
          hasTouch: attachmentBrowser(browser).touch > 0,
        },
        async ({ page }) => {
          await installAttachmentBrowserIdentity(page, attachmentBrowser(browser));
          const gateway = await installMockGateway(page, { historyMessages: [] });
          await page.goto(suite.server.baseUrl + route);
          const editor = page
            .locator(
              ".agent-chat__composer-combobox textarea, .new-session-page__composer textarea",
            )
            .first();
          await editor.fill("Keep this synthetic mixed-media draft.");
          const choose = async () => {
            await page.getByRole("button", { name: "Add attachment", exact: true }).click();
            const mediaAction = page.getByRole("menuitem", {
              name: attachmentBrowser(browser).single ? "Add attachment…" : "Media",
              exact: true,
            });
            await mediaAction.waitFor({ state: "visible" });
            expect(await mediaAction.count()).toBe(1);
            const pending = page.waitForEvent("filechooser");
            await mediaAction.click();
            return pending;
          };
          const chooser = await choose();
          expect(chooser.isMultiple()).toBe(true);
          expect(await chooser.element().getAttribute("accept")).toBe(
            attachmentBrowser(browser).single ? null : "image/*,video/*",
          );
          expect(await chooser.element().getAttribute("capture")).toBeNull();
          await chooser.setFiles([image, video]);
          const ready = page.locator('.chat-attachment-thumb[aria-busy="false"]');
          await expect.poll(() => ready.count()).toBe(2);
          expect(await chooser.element().inputValue()).toBe("");
          await (await choose()).setFiles([]);
          expect(await ready.count()).toBe(2);
          expect(await editor.inputValue()).toBe("Keep this synthetic mixed-media draft.");
          await page.getByRole("button", { name: "Remove synthetic.mp4", exact: true }).click();
          await (await choose()).setFiles(video);
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
                fileName: image.name,
                mimeType: image.mimeType,
                content: image.buffer.toString("base64"),
              },
              {
                fileName: video.name,
                mimeType: video.mimeType,
                content: video.buffer.toString("base64"),
              },
            ],
          });
        },
      ),
  );
});
