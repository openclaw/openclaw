// Control UI tests cover page actions joining the floating phone header against a mocked Gateway.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI floating header page actions mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const PAGES = [
  { path: "usage", trigger: ".usage-phone-actions__trigger", item: "Refresh" },
  { path: "meetings", trigger: ".transcripts-page-menu__trigger", item: "Refresh" },
  { path: "logs", trigger: "button.logs-toolbar__button[title='More actions']", item: "Refresh" },
  { path: "activity?view=live", trigger: ".activity-live-actions__trigger", item: "Expand all" },
  { path: "settings/agents/main/overview", trigger: ".agents-page-menu__trigger", item: "Refresh" },
  { path: "settings/skills", trigger: ".skill-library-search__icon", item: "Search skills" },
] as const;

function install(page: Page) {
  return installMockGateway(page, {
    featureMethods: ["openclaw.chat", "openclaw.chat.history", "openclaw.changes.list"],
    methodResponses: {
      "openclaw.chat.history": { turns: [] },
      "openclaw.changes.list": { entries: [] },
    },
  });
}

async function titleOffset(page: Page, width: number) {
  const box = (await page.locator(".topbar-page-title").boundingBox())!;
  return Math.abs(box.x + box.width / 2 - width / 2);
}

suite.define(() => {
  const width = 320;
  it(`moves page menus into the pill with the title centered at ${width}px`, async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width, height: 800 } },
      async ({ page }) => {
        await install(page);
        for (const { path, trigger, item } of PAGES) {
          await page.goto(`${suite.server.baseUrl}${path}`);
          const inPill = page.locator(`.topnav-shell__page-actions ${trigger}`);
          await inPill.waitFor();
          expect(await page.locator(`main.content ${trigger}`).count()).toBe(0);
          await expect.poll(() => titleOffset(page, width)).toBeLessThan(1);

          await inPill.click();
          await expect
            .poll(() => page.getByRole("menuitem", { name: item, exact: true }).count())
            .toBe(1);
          await page.keyboard.press("Escape");
        }
      },
    );
  });
  it("moves New agent and Refresh into the Agents menu, with no row above the tabs", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 390, height: 800 } },
      async ({ page }) => {
        await install(page);
        await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
        const trigger = page.locator(".agents-page-menu__trigger");
        await trigger.waitFor();
        expect(await page.locator(".agents-create-btn").count()).toBe(0);
        expect(
          await page.locator("main.content").getByRole("button", { name: "Refresh" }).count(),
        ).toBe(0);
        expect(await page.locator("main.content .page-header-actions").isVisible()).toBe(false);
        await trigger.click();
        const items = page.getByRole("menuitem");
        await expect.poll(() => items.first().textContent()).toContain("New agent");
        expect(await items.first().isDisabled()).toBe(false);
      },
    );
  });

  it("keeps the menu on the page from 641px, where the header does not float", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 641, height: 800 } },
      async ({ page }) => {
        await install(page);
        await page.goto(`${suite.server.baseUrl}meetings`);
        await page.locator("main.content .transcripts-page-menu__trigger").waitFor();
        expect(await page.locator(".topnav-shell__page-actions").count()).toBe(0);
        expect(await page.locator(".transcripts-page-menu__trigger").count()).toBe(1);
      },
    );
  });
});
