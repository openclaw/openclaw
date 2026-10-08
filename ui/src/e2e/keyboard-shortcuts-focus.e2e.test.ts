import { expect, it } from "vitest";
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
          // Keep the opening control connected across navigation, like a sidebar session link.
          await page.locator(".nav-item--home").click();
          await page.keyboard.press(`${modifier}+/`);
          const hint = page
            .locator("openclaw-keyboard-shortcuts-dialog .shortcut-row")
            .filter({ hasText: "Open New Session" });
          await hint.waitFor({ state: "visible" });
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
