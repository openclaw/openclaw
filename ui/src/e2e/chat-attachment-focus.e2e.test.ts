import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowser,
  attachmentOption,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment opening focus" });

suite.define(() => {
  it.each(["file", "media"] as const)(
    "keeps native %s selection across the real opening animation",
    async (kind) => {
      const fixture = attachmentBrowser("Android Chrome");
      await suite.withPage(
        {
          userAgent: fixture.userAgent,
          hasTouch: true,
          viewport: { width: 1024, height: 768 },
          reducedMotion: "no-preference",
        },
        async ({ page }) => {
          await installAttachmentBrowserIdentity(page, fixture);
          // This suite covers the retained input route; direct Files has its own browser proof.
          await page.addInitScript(() => {
            Object.defineProperty(window, "showOpenFilePicker", {
              configurable: true,
              value: undefined,
            });
          });
          await installMockGateway(page);
          // Arm interception before raw keyboard input can open a chooser.
          page.on("filechooser", () => {});
          await page.goto(suite.server.baseUrl + "chat");
          const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
          const menu = page.locator(".agent-chat__attach-menu .oc-menu");
          await menu.waitFor({ state: "attached" });
          await menu.evaluate((element) => {
            element.style.setProperty("--oc-overlay-show-duration", "10s");
          });
          await trigger.press("Enter");
          const animationCount = await menu.evaluate((element) => {
            const animations = element.getAnimations();
            for (const animation of animations) {
              animation.pause();
            }
            return animations.length;
          });
          expect(animationCount).toBeGreaterThan(0);
          expect(await menu.getAttribute("data-phase")).toBe("opening");
          await attachmentOption(page, kind).focus();
          await menu.evaluate(async (element) => {
            const animations = element.getAnimations();
            const shown = new Promise<void>((resolve) => {
              element.addEventListener("overlay-after-show", () => resolve(), { once: true });
            });
            for (const animation of animations) {
              await animation.ready;
              animation.finish();
            }
            await shown;
          });
          expect(
            await page.evaluate(() => document.activeElement?.getAttribute("data-value")),
          ).toBe(kind);
          const pending = page.waitForEvent("filechooser");
          await page.keyboard.press("Enter");
          const chooser = await pending;
          expect(await chooser.element().getAttribute("class")).toBe(`agent-chat__${kind}-input`);
          expect(await chooser.element().getAttribute("capture")).toBeNull();
          expect(chooser.isMultiple()).toBe(true);
          await chooser.setFiles([]);
          expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
          await menu.evaluate((el) => el.style.removeProperty("--oc-overlay-show-duration"));
          // Reopen immediately after cancellation and select before show settles.
          await trigger.press("Enter");
          const reopened = page.waitForEvent("filechooser");
          await attachmentOption(page, kind).press("Enter");
          const next = await reopened;
          expect(await next.element().getAttribute("class")).toBe(`agent-chat__${kind}-input`);
          await next.setFiles([]);
        },
      );
    },
  );
});
