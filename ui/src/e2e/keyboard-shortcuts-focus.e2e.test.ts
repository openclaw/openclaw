import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { platform: "Linux x86_64", modifier: "Control" },
    { platform: "MacIntel", modifier: "Meta" },
  ])(
    "traverses sidebar sessions without stealing editable keys on $platform",
    async ({ platform, modifier }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.addInitScript((value) => {
          Object.defineProperty(navigator, "platform", { get: () => value });
        }, platform);
        const keys = ["agent:main:first", "agent:main:second", "agent:main:third"];
        await installMockGateway(page, {
          sessionKey: keys[0],
          sessions: keys.map((key, index) => ({
            key,
            displayName: `Traversal ${index + 1}`,
            kind: "direct",
            updatedAt: 300 - index,
          })),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, keys[0]));
        const composer = page.locator(".agent-chat__composer-combobox > textarea:visible");
        await composer.waitFor();
        const rows = page.locator("openclaw-app-sidebar [data-session-key]");
        await expect.poll(() => rows.count()).toBe(3);
        const order = await rows.evaluateAll((elements) =>
          elements.map((el) => el.getAttribute("data-session-key")),
        );
        const selectedKey = () =>
          page
            .locator('openclaw-app-sidebar [aria-current="page"]')
            .evaluate((el) => el.closest("[data-session-key]")?.getAttribute("data-session-key"));
        await composer.fill("Keep this draft");
        await page.keyboard.press(`${modifier}+]`);
        expect(await selectedKey()).toBe(keys[0]);
        expect(await composer.inputValue()).toBe("Keep this draft");
        if (modifier === "Meta") {
          await page.evaluate(() =>
            window.dispatchEvent(new Event("openclaw:native-next-session")),
          );
          expect(await selectedKey()).toBe(keys[0]);
          await page.evaluate(async () => {
            const frame = document.createElement("iframe");
            frame.srcdoc = "<textarea>Embedded draft</textarea>";
            const loaded = new Promise<void>((resolve) => {
              frame.addEventListener("load", () => resolve(), { once: true });
            });
            document.body.append(frame);
            await loaded;
            frame.contentDocument!.querySelector("textarea")!.focus();
            window.dispatchEvent(new Event("openclaw:native-next-session"));
            frame.remove();
          });
          expect(await selectedKey()).toBe(keys[0]);
        }
        // Move focus out of the composer after each navigation: chat owns autofocus.
        const focusSession = async () => {
          await page.locator('openclaw-app-sidebar [aria-current="page"]').focus();
        };
        const start = order.indexOf(keys[0]);
        await focusSession();
        await page.evaluate(() => {
          document.addEventListener("keydown", (event) => {
            if (event.repeat && event.key === "]") {
              document.documentElement.dataset.traversalRepeatPrevented = String(
                event.defaultPrevented,
              );
            }
          });
        });
        await page.keyboard.down(modifier);
        await page.keyboard.down("]");
        await expect.poll(selectedKey).toBe(order[(start + 1) % order.length]);
        await page.keyboard.down("]");
        await expect
          .poll(() => page.locator("html").getAttribute("data-traversal-repeat-prevented"))
          .toBe("true");
        expect(await selectedKey()).toBe(order[(start + 1) % order.length]);
        await page.keyboard.up("]");
        await page.keyboard.up(modifier);
        await focusSession();
        await page.keyboard.press(`${modifier}+[`);
        await expect.poll(selectedKey).toBe(keys[0]);
        await expect.poll(() => composer.inputValue()).toBe("Keep this draft");
        if (modifier === "Meta") {
          await focusSession();
          await page.evaluate(() =>
            window.dispatchEvent(new Event("openclaw:native-next-session")),
          );
          await expect.poll(selectedKey).toBe(order[(start + 1) % order.length]);
          await focusSession();
          await page.evaluate(() =>
            window.dispatchEvent(new Event("openclaw:native-previous-session")),
          );
          await expect.poll(selectedKey).toBe(keys[0]);
        }
        await focusSession();
        await page.keyboard.press(`${modifier}+[`);
        await expect.poll(selectedKey).toBe(order[(start + order.length - 1) % order.length]);
        await page.keyboard.press(`${modifier}+/`);
        await page
          .locator("openclaw-keyboard-shortcuts-dialog .shortcut-row")
          .filter({ hasText: "Previous session" })
          .waitFor({ state: "visible" });
        const before = await selectedKey();
        await page.keyboard.press(`${modifier}+]`);
        expect(await selectedKey()).toBe(before);
      });
    },
  );

  it.each([
    { platform: "Linux x86_64", modifier: "Control" },
    { platform: "MacIntel", modifier: "Meta" },
  ])(
    "keeps New Session focus after dismissing shortcuts on $platform",
    async ({ platform, modifier }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.addInitScript((value) => {
          Object.defineProperty(navigator, "platform", { get: () => value });
        }, platform);
        await installMockGateway(page);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await page.locator(".agent-chat__composer-combobox > textarea").waitFor();
        // Cover both lazy-loaded and already-loaded shortcut/draft surfaces.
        for (let iteration = 0; iteration < 2; iteration += 1) {
          // A fixed rail control keeps the shortcut origin connected across navigation.
          await page
            .locator("openclaw-app-sidebar")
            .getByRole("button", { name: "Sessions", exact: true })
            .click();
          await page.keyboard.press(`${modifier}+/`);
          const hint = page
            .locator("openclaw-keyboard-shortcuts-dialog .shortcut-row")
            .filter({ hasText: "Open New Session" });
          await hint.waitFor({ state: "visible" });
          if (
            iteration === 0 &&
            platform === "MacIntel" &&
            process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ) {
            await writeFile(
              path.join(suite.artifactDir, "keyboard-shortcuts.png"),
              await takeControlUiViewportScreenshot(page, hint, [hint]),
            );
          }
          await page.keyboard.press("Escape");
          await hint.waitFor({ state: "hidden" });
          await page.keyboard.press(`${modifier}+Shift+O`);
          const draft = page.locator("openclaw-new-session-page .new-session-page__message");
          await draft.waitFor({ state: "visible" });
          // Observe queued dismissal and route frames before accepting stable focus.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
              }),
          );
          await expect
            .poll(() => draft.evaluate((element) => element === document.activeElement))
            .toBe(true);
          await page.keyboard.type("A new draft");
          await expect.poll(() => draft.inputValue()).toBe("A new draft");
          await draft.fill("");
          await page.goBack();
          await page.locator(".agent-chat__composer-combobox > textarea").waitFor();
        }
      });
    },
  );
});
