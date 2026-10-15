import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  attachmentBrowserFixtures,
  installAttachmentBrowserIdentity,
} from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment opening focus" });

suite.define(() => {
  it.each(["file", "photo"] as const)(
    "keeps native %s selection across the real opening animation",
    async (kind) => {
      const fixture = attachmentBrowserFixtures.find((entry) => entry.name === "Android Chrome");
      if (!fixture) {
        throw new Error("Missing Android attachment fixture");
      }
      await suite.withPage(
        {
          userAgent: fixture.userAgent,
          hasTouch: true,
          viewport: { width: 1024, height: 768 },
          reducedMotion: "no-preference",
        },
        async ({ page }) => {
          await installAttachmentBrowserIdentity(page, fixture);
          await installMockGateway(page, { historyMessages: [] });
          // Keep the native chooser subscription alive before opening: raw keyboard
          // input must not race Playwright enabling interception on its first listener.
          page.on("filechooser", () => {});
          await page.goto(suite.server.baseUrl + "chat");
          const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
          const menu = page.locator(".agent-chat__attach-menu .oc-menu");
          await menu.waitFor({ state: "attached" });
          // Hold the real CSS transition long enough to pause it after native opening.
          // Keyboard selection and the filechooser still use the production menu.
          await menu.evaluate((element) => {
            element.style.setProperty("--oc-overlay-show-duration", "10s");
          });
          try {
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
            // Locator focus is the same consumer intent as the existing chooser test.
            await page
              .locator('.agent-chat__attach-menu-option[data-value="' + kind + '"]')
              .focus();
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
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              await page.screenshot({
                path: path.join(suite.artifactDir, kind + "-opening-focus.png"),
              });
            }
            const focus = await page.evaluate(() =>
              document.activeElement?.getAttribute("data-value"),
            );
            expect(focus).toBe(kind);
            const pending = page.waitForEvent("filechooser");
            await page.keyboard.press("Enter");
            const chooser = await pending;
            expect(await chooser.element().getAttribute("class")).toBe(
              "agent-chat__" + kind + "-input",
            );
            expect(chooser.isMultiple()).toBe(true);
            expect(await chooser.element().getAttribute("capture")).toBeNull();
            // Boundary cancellation, not certification of a native OS dialog.
            await chooser.setFiles([]);
            expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
          } finally {
            await menu.evaluate((element) => {
              element.style.removeProperty("--oc-overlay-show-duration");
            });
          }
          // Reopen immediately after cancellation and select before show settles.
          await trigger.press("Enter");
          const reopened = page.waitForEvent("filechooser");
          await page
            .locator('.agent-chat__attach-menu-option[data-value="' + kind + '"]')
            .press("Enter");
          const chooser = await reopened;
          expect(await chooser.element().getAttribute("class")).toBe(
            "agent-chat__" + kind + "-input",
          );
          await chooser.setFiles([]);
        },
      );
    },
  );
});
