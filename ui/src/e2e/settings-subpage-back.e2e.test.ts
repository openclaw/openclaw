import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings subpage back" });
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true };

suite.define(() => {
  it.each([
    ["settings/ai-agents", "/settings/agents"],
    ["settings/lobsterdex", "/settings/appearance"],
  ])("goes up from %s on a phone", async (path, parent) => {
    await suite.withPage(phone, async ({ page }) => {
      await installMockGateway(page, { operatorScopes: ["operator.read", "operator.admin"] });
      await page.goto(`${suite.server.baseUrl}${path}`);
      await page.locator(".topbar-back").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(parent);
      await page.locator(".topbar-nav-toggle:not(.topbar-back)").waitFor();
      expect(await page.locator(".topbar-back").count()).toBe(0);
    });
  });

  it("steps out of a plugin one level at a time on a phone", async () => {
    await suite.withPage(phone, async ({ page }) => {
      await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.admin"],
        methodResponses: pluginResponses(),
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
      await page.locator(".plugin-editor").waitFor();
      expect(await page.locator(".plugins-settings-breadcrumb").isVisible()).toBe(true);
      await page.locator(".topbar-back").click();
      await expect.poll(() => new URL(page.url()).search).toBe("");
      expect(new URL(page.url()).pathname).toBe("/settings/plugins/workboard");
      await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
      expect(await page.locator(".plugins-settings-breadcrumb").isVisible()).toBe(false);
      await page.locator(".topbar-back").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
      await page.getByRole("searchbox").first().waitFor();
      expect(await page.locator(".topbar-back").count()).toBe(0);
    });
  });

  it.each([390, 1440])("keeps Escape on the same plugin parent as Back at %ipx", async (width) => {
    await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.admin"],
        methodResponses: pluginResponses(),
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins`);
      const search = page.getByRole("searchbox", { name: "Search installed plugins", exact: true });
      await search.fill("Workboard");
      await page.locator('a[href="/settings/plugins/workboard"]').click();
      await page
        .locator(".plugin-catalog-detail__actions")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await page.locator(".plugin-editor").waitFor();
      await page.keyboard.press("Escape");
      await expect
        .poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
        .toBe("/settings/plugins/workboard");
      await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await search.waitFor();
      expect(await search.inputValue()).toBe("Workboard");
      expect(await page.locator("article[data-plugin-id]").count()).toBe(1);
    });
  });

  it("keeps the desktop chrome unchanged", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { operatorScopes: ["operator.read", "operator.admin"] });
      await page.goto(`${suite.server.baseUrl}settings/ai-agents`);
      await page.locator(".settings-sidebar").waitFor();
      expect(await page.locator(".topbar-back").count()).toBe(0);
    });
  });
});
