import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Home panel composer focus mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const WORK_SESSION_KEY = "agent:main:work";
const HOME_SESSION_KEY = "agent:main:main";
const contextOptions = { colorScheme: "dark", ...createControlUiE2eContextOptions() } as const;

async function openWorkPage(page: Page) {
  await installMockGateway(page, {
    sessionKey: WORK_SESSION_KEY,
    sessions: [
      { key: WORK_SESSION_KEY, kind: "direct", label: "Work", updatedAt: 2 },
      { key: HOME_SESSION_KEY, kind: "main", label: "Home", updatedAt: 1 },
    ],
    featureMethods: ["chat.metadata", "chat.startup", "chat.history", "chat.send"],
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, WORK_SESSION_KEY));
  const work = page.locator("openclaw-chat-page");
  await work.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
  return page
    .locator("openclaw-assistant-panel openclaw-home-session")
    .getByRole("textbox", { name: "Chat composer", exact: true });
}

function caret(composer: Locator) {
  return composer.evaluate((element) =>
    element instanceof HTMLTextAreaElement
      ? { start: element.selectionStart, end: element.selectionEnd, length: element.value.length }
      : null,
  );
}

suite.define(() => {
  it("focuses the Home composer when the shortcut opens the dock and closes it on the next press", async () => {
    await suite.withPage({ ...contextOptions, reducedMotion: "reduce" }, async ({ page }) => {
      const composer = await openWorkPage(page);

      await page.keyboard.press("ControlOrMeta+Shift+H");
      await composer.waitFor();
      await expect.poll(() => composer.evaluate((element) => element.matches(":focus"))).toBe(true);
      await page.keyboard.type("Draft for Home");
      expect(await composer.inputValue()).toBe("Draft for Home");

      // A second press keeps the established toggle: it closes the open dock.
      await page.keyboard.press("ControlOrMeta+Shift+H");
      await composer.waitFor({ state: "hidden" });

      await page.keyboard.press("ControlOrMeta+Shift+H");
      await composer.waitFor();
      await expect.poll(() => composer.evaluate((element) => element.matches(":focus"))).toBe(true);
      expect(await composer.inputValue()).toBe("Draft for Home");
      expect(await caret(composer)).toEqual({ start: 14, end: 14, length: 14 });
    });
  });

  it("focuses the Home composer when the sidebar button opens the dock", async () => {
    await suite.withPage({ ...contextOptions, reducedMotion: "reduce" }, async ({ page }) => {
      const composer = await openWorkPage(page);

      await page.locator(".sidebar-footer-bar__home").click();
      await composer.waitFor();
      await expect.poll(() => composer.evaluate((element) => element.matches(":focus"))).toBe(true);
    });
  });
});
