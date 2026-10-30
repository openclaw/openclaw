import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowser,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native camera video return" });
const video = {
  name: "synthetic-capture.mp4",
  mimeType: "video/mp4",
  buffer: readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url)),
};

suite.define(() => {
  it.each([
    { browser: "Android Chrome", route: "chat", keyboard: false },
    { browser: "Android Firefox", route: "new", keyboard: true },
  ])(
    "attaches a native video and sends explicitly from $route ($browser)",
    ({ browser, route, keyboard }) =>
      suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          userAgent: attachmentBrowser(browser).userAgent,
          hasTouch: true,
        },
        async ({ page }) => {
          await installAttachmentBrowserIdentity(page, attachmentBrowser(browser));
          await page.addInitScript(() => {
            navigator.mediaDevices.getUserMedia = async () => {
              document.documentElement.dataset.previewRequested = "true";
              throw new DOMException("Preview must not start for native video", "NotAllowedError");
            };
            document.addEventListener(
              "click",
              (event) => {
                const input = event.target;
                if (input instanceof HTMLInputElement && input.hasAttribute("capture")) {
                  input.dataset.gestureActive = String(navigator.userActivation.isActive);
                }
              },
              true,
            );
          });
          const gateway = await installMockGateway(page, { historyMessages: [] });
          await page.goto(suite.server.baseUrl + route);
          const editor = page
            .locator(
              ".agent-chat__composer-combobox textarea, .new-session-page__composer textarea",
            )
            .first();
          await editor.fill("Keep this synthetic camera draft.");
          const picker = page.locator(".agent-chat__camera-video-input");
          expect(await picker.evaluate((element) => getComputedStyle(element).display)).toBe(
            "none",
          );
          const choose = async () => {
            await page.getByRole("button", { name: "Add attachment", exact: true }).click();
            const action = page.getByRole("menuitem", { name: "Record video", exact: true });
            await action.waitFor({ state: "visible" });
            const pending = page.waitForEvent("filechooser");
            if (keyboard) {
              await action.press("Enter");
            } else {
              await action.click();
            }
            const chooser = await pending;
            expect(chooser.isMultiple()).toBe(false);
            expect(await chooser.element().getAttribute("accept")).toBe("video/*");
            expect(await chooser.element().getAttribute("capture")).toBe("environment");
            expect(await chooser.element().getAttribute("data-gesture-active")).toBe("true");
            return chooser;
          };
          await (await choose()).setFiles([]);
          expect(await editor.inputValue()).toBe("Keep this synthetic camera draft.");
          expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
          await (await choose()).setFiles(video);
          const ready = page.locator('.chat-attachment-thumb[aria-busy="false"]');
          await expect.poll(() => ready.count()).toBe(1);
          expect(await picker.inputValue()).toBe("");
          expect(await page.locator("html").getAttribute("data-preview-requested")).toBeNull();
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          expect(await gateway.getRequests("sessions.create")).toEqual([]);
          await page
            .getByRole("button", { name: "Remove synthetic-capture.mp4", exact: true })
            .click();
          await (await choose()).setFiles(video);
          await expect.poll(() => ready.count()).toBe(1);
          await page
            .getByRole("button", {
              name: route === "chat" ? "Send message" : "Start session",
              exact: true,
            })
            .click();
          const request = await gateway.waitForRequest(
            route === "chat" ? "chat.send" : "sessions.create",
          );
          expect(request.params).toMatchObject({
            attachments: [
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
