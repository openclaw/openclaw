import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";
import { expectAttribute, expectPath } from "./sidebar-assertions.test-support.ts";
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar settings mocked Gateway E2E");

let page: Page;
async function openSettings() {
  await page.keyboard.press("Control+Shift+,");
  return waitForControlUiSettingsTakeover(page);
}
async function openNewSession() {
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").waitFor({ state: "visible" });
}

suite.define(() => {
  beforeEach(async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    page = await context.newPage();
  });

  it("dismisses an open font picker before exiting Settings with Escape", async () => {
    await installMockGateway(page);
    await openNewSession();
    await openSettings();
    const picker = page.locator("openclaw-select-picker:has(#settings-font-chat)");
    const trigger = picker.locator(".picker-select__trigger");
    await trigger.click();
    const selected = picker.locator('[role="option"][aria-selected="true"]');
    await selected.waitFor({ state: "visible" });
    const selectedValue = await selected.getAttribute("data-value");
    const selectedLabel = await trigger.textContent();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expectPath(page, "/settings/appearance");
    await expectAttribute(trigger, "aria-expanded", "false");
    expect(await trigger.textContent()).toBe(selectedLabel);
    await trigger.click();
    expect(await selected.getAttribute("data-value")).toBe(selectedValue);
    await page.keyboard.press("Escape");
    expect(await trigger.evaluate((input) => input.matches(":focus"))).toBe(true);
    await page.keyboard.press("Escape");
    await expectPath(page, "/new");
  });

  it.each([
    { state: "open sidebar", collapseSidebar: false, nativeWebChrome: false },
    { state: "closed sidebar", collapseSidebar: true, nativeWebChrome: false },
    { state: "native web chrome", collapseSidebar: false, nativeWebChrome: true },
  ])("keeps Inbox out of Settings after $state", async (testCase) => {
    if (testCase.nativeWebChrome) {
      await installNativeWebChrome(page);
    }
    await installMockGateway(page);

    await openNewSession();
    if (testCase.collapseSidebar) {
      await page.locator('[data-navigation-view][aria-pressed="true"]').click();
      await page.locator(".shell--nav-collapsed").waitFor();
    }
    const chatInbox = page.locator(".sidebar-rail__bottom .sidebar-issues-button");
    await chatInbox.waitFor({ state: "visible" });

    await openSettings();
    expect(await page.locator(".sidebar-issues-button").count()).toBe(0);
  });

  it.each([
    { mode: "standalone", webChrome: false },
    { mode: "native web chrome", webChrome: true },
  ])("aligns the settings search with navigation rows in $mode", async ({ webChrome }) => {
    await page.setViewportSize({ height: 620, width: 1440 });
    if (webChrome) {
      await installNativeWebChrome(page);
    }
    await installMockGateway(page);

    await page.goto(`${suite.server.baseUrl}settings/general`);
    const { search: settingsSearchInput, sidebar: settingsSidebar } =
      await waitForControlUiSettingsTakeover(page);
    const settingsSearchShell = settingsSidebar.locator(".settings-sidebar__search");
    const settingsNav = settingsSidebar.locator(".settings-sidebar__nav");
    const firstSettingsLink = settingsSidebar.locator(".settings-sidebar__item").first();
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((element) => element.classList.contains("openclaw-native-web-chrome")),
      )
      .toBe(webChrome);
    await expect
      .poll(async () => {
        const [shell, input, link, nav] = await Promise.all([
          settingsSearchShell.boundingBox(),
          settingsSearchInput.boundingBox(),
          firstSettingsLink.boundingBox(),
          settingsNav.boundingBox(),
        ]);
        return shell && input && link && nav
          ? {
              left: Math.round(shell.x - link.x),
              gap: Math.round(nav.y - (input.y + input.height)),
            }
          : null;
      })
      .toEqual({ left: 0, gap: 8 });
    await settingsNav.evaluate((element) => {
      element.scrollTop = Math.min(48, element.scrollHeight - element.clientHeight);
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() =>
        settingsSearchShell.evaluate((element) => ({
          scrolled: element.classList.contains("settings-sidebar__search--scrolled"),
          opacity: getComputedStyle(element, "::after").opacity,
        })),
      )
      .toEqual({ scrolled: true, opacity: "1" });
  });
});
