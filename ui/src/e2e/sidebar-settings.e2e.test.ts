import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { compactCronJobFixture } from "../test-helpers/cron.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";
import {
  expectAttribute,
  expectCount,
  expectExactText,
  expectPath,
} from "./sidebar-assertions.test-support.ts";
import {
  createSidebarCustomizationSuite,
  sidebarCronJob,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar settings mocked Gateway E2E");

const INBOX_COUNT = "openclaw-app-sidebar .sidebar-issues-button__count";
const RAIL_INBOX = ".sidebar-rail__bottom openclaw-sidebar-attention";
let page: Page;
const railButton = () => page.locator(`${RAIL_INBOX} .sidebar-issues-button`);
const railCount = () => page.locator(`${RAIL_INBOX} .sidebar-issues-button__count`);
async function openSettings() {
  await page.keyboard.press("Control+Shift+,");
  return waitForControlUiSettingsTakeover(page);
}
async function openNewSession() {
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").waitFor({ state: "visible" });
}

const FAILED_CRON_RESPONSE = {
  jobs: [
    compactCronJobFixture(
      sidebarCronJob({
        id: "failed-settings-transition",
        name: "Failed settings transition",
      }),
    ),
  ],
  snapshotRevision: "settings-transition-attention",
  total: 1,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};

const MISSING_AUTH_RESPONSE = {
  ts: 1,
  providers: [{ provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] }],
};

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

  it("keeps loaded Inbox attention through collapsed chat and Settings", async () => {
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": FAILED_CRON_RESPONSE,
        "models.authStatus": MISSING_AUTH_RESPONSE,
      },
    });

    await openNewSession();
    await page.locator('[data-navigation-view][aria-pressed="true"]').click();
    await expectExactText(railCount(), "2");

    await openSettings();
    expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);

    await page.keyboard.press("Escape");
    await expectPath(page, "/new");
    await railButton().waitFor({ state: "visible" });
    expect(await railCount().textContent()).toBe("2");

    await gateway.setMethodResponse("cron.list", {
      ...FAILED_CRON_RESPONSE,
      jobs: [],
      total: 0,
    });
    await gateway.setMethodResponse("models.authStatus", { ts: 2, providers: [] });
    for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
      await gateway.deferNext(method);
    }
    await openSettings();
    await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
    await page.getByLabel("Gateway secret", { exact: true }).fill("replacement-owner-token");
    await page.getByRole("button", { name: "Apply and reconnect", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase))
      .toBe("connected");
    await page.keyboard.press("Escape");
    await expectPath(page, "/new");
    await railButton().waitFor();
    expect(await railCount().count()).toBe(0);
  });

  it("keeps one rail attention badge across expanded and collapsed navigation", async () => {
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": { ...FAILED_CRON_RESPONSE, jobs: [], total: 0 },
        "models.authStatus": { ts: 1, providers: [] },
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await gateway.waitForRequest("cron.list");
    await expectCount(page.locator(INBOX_COUNT), 0);

    await page.locator('[data-navigation-view][aria-pressed="true"]').click();
    await railButton().waitFor();
    expect(await page.locator(".sidebar-issues-button").count()).toBe(1);
    expect(await page.locator(".sidebar-shell").isVisible()).toBe(false);
    await page.locator('[data-navigation-view="sessions"]').click();
    await page.locator("openclaw-app-sidebar .sidebar-issues-button").waitFor();

    await gateway.setMethodResponse("cron.list", FAILED_CRON_RESPONSE);
    await gateway.emitGatewayEvent("cron", {
      action: "finished",
      completionStatus: "failed",
      error: "Provider request failed",
      jobId: "failed-settings-transition",
      status: "error",
    });
    await expectExactText(page.locator(INBOX_COUNT), "1");

    for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
      await gateway.deferNext(method);
    }
    await page.locator('[data-navigation-view][aria-pressed="true"]').click();
    await expectExactText(railCount(), "1");
  });

  it("keeps Gateway connection fields editable by their visible labels", async () => {
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      featureMethods: ["system.info"],
      methodResponses: { "system.info": deviceSystemInfo },
    });

    const routeModule = await holdModuleResponse(
      page,
      /\/assets\/connection-page-[^/]+\.js(?:\?|$)/u,
    );
    await page.goto(`${suite.server.baseUrl}settings/connection`);
    await routeModule.request;
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    // The route must start diagnostics even when connection and focus precede its mount.
    await gateway.waitForRequest("connect");
    routeModule.release();

    const fields = (
      [
        ["Gateway URL", "ws://gateway.example.test:18789"],
        ["Gateway secret", "browser-proof-secret"],
        ["Default session", "browser-proof-session"],
      ] as const
    ).map(([label, value]) => ({ input: page.getByLabel(label, { exact: true }), value }));
    const credential = fields[1]!.input;
    for (const { input } of fields) {
      await input.waitFor({ state: "visible" });
      expect(await input.isEditable()).toBe(true);
    }
    for (const { input, value } of fields) {
      await input.fill(value);
    }
    expect(await Promise.all(fields.map(({ input }) => input.inputValue()))).toEqual(
      fields.map(({ value }) => value),
    );

    await page.getByRole("button", { name: "Toggle secret visibility", exact: true }).click();
    expect(await credential.getAttribute("type")).toBe("text");
    expect(await credential.inputValue()).toBe("browser-proof-secret");
    expect(await credential.isEditable()).toBe(true);

    await gateway.waitForRequest("system.info");
    const reads = (await gateway.getRequests("system.info")).length;
    const connections = (await gateway.getRequests("connect")).length;
    await gateway.deferNext("connect");
    await gateway.closeLatest(1012, "synthetic reconnect");
    const notice = page.locator('.connection-action-block[role="status"]');
    await expectAttribute(credential, "type", "password");
    expect(await notice.count()).toBe(0);
    for (const { input } of fields) {
      expect(await input.isEditable()).toBe(true);
    }
    await gateway.waitForRequest("connect", { after: connections });
    await gateway.resolveDeferred("connect");
    await gateway.waitForRequest("system.info", { after: reads });
    expect(await credential.getAttribute("type")).toBe("password");

    for (const { input, value } of fields) {
      expect(await input.inputValue()).toBe(value);
      expect(await input.isEditable()).toBe(true);
    }
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
