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
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

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

async function setVisibility(target: Page, visibility: "hidden" | "visible", focus = false) {
  await target.evaluate(
    ({ value, wake }) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
      if (wake) {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      }
    },
    { value: visibility, wake: focus },
  );
}

const FAILED_CRON_RESPONSE = {
  jobs: [
    compactCronJobFixture({
      id: "failed-settings-transition",
      name: "Failed settings transition",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "test" },
      state: { lastRunStatus: "error", lastError: "Provider request failed" },
    }),
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

const cronFailure = (name: string) => ({
  ...FAILED_CRON_RESPONSE,
  jobs: [{ ...FAILED_CRON_RESPONSE.jobs[0], name }],
});

suite.define(() => {
  beforeEach(async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    page = await context.newPage();
  });
  it("defers hidden Inbox inventory and shows fresh cron attention on return", async () => {
    await page.clock.setFixedTime(Date.now());
    const gateway = await installMockGateway(page, {
      presenceUsers: [{ self: true, id: "alice", name: "Alice" }],
      methodResponses: {
        "cron.list": FAILED_CRON_RESPONSE,
        "models.authStatus": MISSING_AUTH_RESPONSE,
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const badge = page.locator(INBOX_COUNT);
    await expect.poll(() => badge.textContent()).toBe("2");
    await page.locator("openclaw-app-sidebar .sidebar-issues-button").click();
    await page.getByText("Failed settings transition", { exact: true }).waitFor();

    await setVisibility(page, "hidden");
    await gateway.setMethodResponse("cron.list", cronFailure("Failure while away"));
    for (let index = 0; index < 20; index++) {
      await gateway.emitGatewayEvent("cron", { action: "finished", jobId: `hidden-${index}` });
    }
    for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
      expect(await gateway.getRequests(method)).toHaveLength(1);
    }
    await page.getByText("Failed settings transition", { exact: true }).waitFor();
    await setVisibility(page, "visible", true);
    await page.getByText("Failure while away", { exact: true }).waitFor();
    expect(await badge.textContent()).toBe("2");
    for (const method of ["cron.list", "cron.status"]) {
      expect(await gateway.getRequests(method)).toHaveLength(2);
    }
    expect(await gateway.getRequests("models.authStatus")).toHaveLength(1);

    await gateway.deferNext("cron.list");
    await gateway.emitGatewayEvent("cron", { action: "finished" });
    await gateway.waitForRequest("cron.list", { after: 2 });
    await page.getByRole("button", { name: "Dismiss Failure while away", exact: true }).click();
    await setVisibility(page, "hidden");
    // The first event invalidating this pending inventory arrives while hidden.
    await gateway.emitGatewayEvent("cron", { action: "finished" });
    await gateway.resolveDeferred("cron.list", { ...FAILED_CRON_RESPONSE, jobs: [], total: 0 });
    expect(await gateway.getRequests("cron.list")).toHaveLength(3);
    await gateway.deferNext("cron.list");
    await setVisibility(page, "visible");
    await gateway.waitForRequest("cron.list", { after: 3 });
    await gateway.resolveDeferred("cron.list", {
      ...FAILED_CRON_RESPONSE,
      jobs: [
        FAILED_CRON_RESPONSE.jobs[0],
        { ...FAILED_CRON_RESPONSE.jobs[0], id: "fresh-job", name: "Fresh visible warning" },
      ],
      total: 2,
    });
    await page.getByText("Fresh visible warning", { exact: true }).waitFor();
    expect(await page.locator('[data-attention-kind="cronFailed"]').count()).toBe(1);
    expect(await badge.textContent()).toBe("2");
    expect(await gateway.getRequests("cron.list")).toHaveLength(4);
  });

  it("refreshes stale auth attention after metadata changes while the first read is pending", async () => {
    const now = Date.now();
    await page.clock.setFixedTime(now);
    const gateway = await installMockGateway(page, {
      heldMethods: ["models.authStatus"],
      methodResponses: { "cron.list": FAILED_CRON_RESPONSE },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const badge = page.locator(INBOX_COUNT);
    await expect.poll(() => badge.textContent()).toBe("1");
    await gateway.waitForRequest("models.authStatus");
    await page.clock.setFixedTime(now + 60_001);
    await page.evaluate(() => {
      for (let index = 0; index < 20; index++) {
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    expect(await gateway.getRequests("models.authStatus")).toHaveLength(1);
    for (let index = 0; index < 20; index++) {
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
    }
    expect(await gateway.getRequests("models.authStatus")).toHaveLength(1);
    await gateway.deferNext("models.authStatus");
    await gateway.resolveDeferred("models.authStatus", MISSING_AUTH_RESPONSE);
    await gateway.waitForRequest("models.authStatus", { after: 1 });
    await expect.poll(() => badge.textContent()).toBe("2");
    await page.locator("openclaw-app-sidebar .sidebar-issues-button").click();
    const authWarning = page.locator('[data-attention-kind="modelAuthExpired"]');
    await authWarning.waitFor({ state: "visible" });
    await gateway.resolveDeferred("models.authStatus", { ts: now + 60_001, providers: [] });
    await authWarning.waitFor({ state: "hidden" });
    await expect.poll(() => badge.textContent()).toBe("1");
    expect(await gateway.getRequests("models.authStatus")).toHaveLength(2);
    for (const index of [1, 2]) {
      await page.clock.setFixedTime(now + 60_001 + 30_001 * index);
      await gateway.setMethodResponse("cron.list", cronFailure(`Recent automation ${index}`));
      await gateway.emitGatewayEvent("cron", { action: "finished" });
      await page.getByText(`Recent automation ${index}`, { exact: true }).waitFor();
      expect(await gateway.getRequests("models.authStatus")).toHaveLength(2);
    }
    await gateway.setMethodResponse("models.authStatus", MISSING_AUTH_RESPONSE);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(await gateway.getRequests("models.authStatus")).toHaveLength(2);
    await gateway.emitGatewayEvent("chat.metadata.changed", {});
    await authWarning.waitFor({ state: "visible" });
    expect(await gateway.getRequests("models.authStatus")).toHaveLength(3);
  });

  it("coalesces cron bursts without losing independently loaded Inbox attention", async () => {
    const gateway = await installMockGateway(page, {
      heldMethods: ["cron.list", "cron.status", "models.authStatus"],
      methodResponses: {
        "cron.list": FAILED_CRON_RESPONSE,
        "models.authStatus": MISSING_AUTH_RESPONSE,
      },
    });

    await openNewSession();
    await gateway.waitForRequest("cron.status");
    await gateway.waitForRequest("models.authStatus");
    for (let index = 0; index < 20; index++) {
      await gateway.emitGatewayEvent("cron", { action: "finished", jobId: `job-${index}` });
    }

    for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
      expect(await gateway.getRequests(method)).toHaveLength(1);
    }

    await gateway.resolveDeferred("models.authStatus");
    const badge = page.locator(INBOX_COUNT);
    await expect.poll(() => badge.textContent()).toBe("1");
    await gateway.resolveDeferred("cron.list");
    expect(await gateway.getRequests("cron.list")).toHaveLength(1);
    await gateway.deferNext("cron.list");
    await gateway.resolveDeferred("cron.status");
    await gateway.waitForRequest("cron.list", { after: 1 });
    await expect.poll(() => badge.textContent()).toBe("2");
    for (const method of ["cron.list", "cron.status"]) {
      expect(await gateway.getRequests(method)).toHaveLength(2);
    }
    await page.locator("openclaw-app-sidebar .sidebar-issues-button").click();
    await page.getByText("Failed settings transition", { exact: true }).waitFor();
    await gateway.setMethodResponse("cron.list", cronFailure("Latest automation failure"));
    await gateway.emitGatewayEvent("cron", { action: "finished", jobId: "latest" });
    await gateway.resolveDeferred("cron.list");
    await gateway.waitForRequest("cron.list", { after: 2 });
    await page.getByText("Latest automation failure", { exact: true }).waitFor();
    for (const method of ["cron.list", "cron.status"]) {
      expect(await gateway.getRequests(method)).toHaveLength(3);
    }
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
    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await trigger.textContent()).toBe(selectedLabel);
    await trigger.click();
    expect(await selected.getAttribute("data-value")).toBe(selectedValue);
    await page.keyboard.press("Escape");
    expect(await trigger.evaluate((input) => input.matches(":focus"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
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
    const railInbox = page.locator(RAIL_INBOX);
    await expect
      .poll(() => railInbox.locator(".sidebar-issues-button__count").textContent())
      .toBe("2");

    await openSettings();
    expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);

    await page.keyboard.press("Escape");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    const restoredInbox = page.locator(RAIL_INBOX);
    await restoredInbox.locator(".sidebar-issues-button").waitFor({ state: "visible" });
    expect(await restoredInbox.locator(".sidebar-issues-button__count").textContent()).toBe("2");

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
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
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
    await expect.poll(() => page.locator(INBOX_COUNT).count()).toBe(0);

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
    await expect.poll(() => page.locator(INBOX_COUNT).textContent()).toBe("1");

    await gateway.deferNext("cron.list");
    await gateway.deferNext("cron.status");
    await gateway.deferNext("models.authStatus");
    await page.locator('[data-navigation-view][aria-pressed="true"]').click();
    await expect
      .poll(() =>
        page
          .locator(".sidebar-rail__bottom openclaw-sidebar-attention .sidebar-issues-button__count")
          .textContent(),
      )
      .toBe("1");
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
    await expect.poll(() => credential.getAttribute("type")).toBe("password");
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
