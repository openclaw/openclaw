import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "compact identity menu" });
const snapshot: NativeGatewaysSnapshot = {
  currentId: "gateway-1",
  gateways: Array.from({ length: 9 }, (_, index) => ({
    id: `gateway-${index + 1}`,
    name: `Gateway ${index + 1}`,
    kind: index === 0 ? "local" : "remote",
    isPrimary: index === 0,
    canPromote: index !== 0,
    health: index === 8 ? "unknown" : index === 7 ? "error" : "ok",
  })),
};

async function openMenu(page: Page) {
  await page.locator(".sidebar-identity-card").click();
  const menu = page.locator(".sidebar-identity-menu");
  await menu.waitFor({ state: "visible" });
  await expect.poll(() => menu.getAttribute("data-phase")).toBe("open");
  return menu;
}

async function expectUnclipped(item: Locator) {
  await expect
    .poll(() =>
      item.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const menu = element.closest('[role="menu"]')!;
        const bounds = menu.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return (
          menu.getAttribute("data-phase") === "open" &&
          rect.top >= Math.max(bounds.top, 0) &&
          rect.bottom <= Math.min(bounds.bottom, innerHeight) &&
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          element.contains(hit)
        );
      }),
    )
    .toBe(true);
}

suite.define(() => {
  it("keeps common actions visible with nine native gateways and opens an unclipped keyboard switcher", async () =>
    suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        await page.addInitScript((initial) => {
          document.addEventListener(
            "DOMContentLoaded",
            () => document.documentElement.classList.add("openclaw-native-macos"),
            { once: true },
          );
          const actions: unknown[] = [];
          const openclawGateways = { postMessage: (message: unknown) => actions.push(message) };
          Object.assign(window, {
            __OPENCLAW_NATIVE_GATEWAYS__: initial,
            nativeGatewayActions: actions,
            webkit: { messageHandlers: { openclawGateways } },
          });
        }, snapshot);
        await installMockGateway(page, { sessions: [], historyMessages: [] });
        await page.goto(`${suite.server.baseUrl}new`);
        await waitForControlUiGatewayReady(page);
        let menu = await openMenu(page);
        await page.mouse.move(1100, 850);
        for (const action of [
          "settings",
          "updates",
          "usage",
          "pair-mobile",
          "debug-overlay",
          "help",
          "theme",
        ]) {
          await expectUnclipped(menu.locator(`[data-value="command:${action}"]`));
        }
        expect(await menu.locator('[data-value="command:apps"]').count()).toBe(0);
        const switcher = menu.locator('[data-value="command:gateways"]');
        expect(await switcher.textContent()).toContain("Gateway 1");
        expect(await switcher.locator(".sidebar-gateway-primary").textContent()).toBe("primary");
        await switcher.focus();
        await page.keyboard.press("ArrowRight");
        const submenu = page.getByRole("menu", { name: "Gateway 1", exact: true });
        await submenu.waitFor({ state: "visible" });
        expect(await submenu.getByRole("menuitemradio").count()).toBe(9);
        expect(await submenu.locator('[aria-checked="true"]').textContent()).toContain("Gateway 1");
        await expectUnclipped(submenu.locator('[data-value="gateway:gateway-9"]'));
        await expectUnclipped(submenu.locator('[data-value="command:gateway-settings"]'));
        await page.keyboard.press("Escape");
        await expect
          .poll(() => switcher.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await menu.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "detached" });
        await page.setViewportSize({ width: 390, height: 500 });
        await page.locator(".topbar-nav-toggle").click();
        menu = await openMenu(page);
        await menu.locator('[data-value="command:gateways"]').click();
        await submenu.waitFor({ state: "visible" });
        await expectUnclipped(submenu.locator('[data-value="gateway:gateway-9"]'));
        await expectUnclipped(submenu.locator('[data-value="command:gateway-settings"]'));
        await submenu.locator('[data-value="gateway:gateway-2"]').click();
        menu = await openMenu(page);
        await menu.locator('[data-value="command:gateways"]').click();
        await expectUnclipped(submenu.locator('[data-value="gateway:gateway-3"]'));
        await submenu.locator('[data-value="gateway:gateway-3"]').click({ modifiers: ["Meta"] });
        menu = await openMenu(page);
        await menu.locator('[data-value="command:gateways"]').click();
        await expectUnclipped(submenu.locator('[data-value="command:gateway-settings"]'));
        await submenu.locator('[data-value="command:gateway-settings"]').click();
        expect(await page.evaluate(() => Reflect.get(window, "nativeGatewayActions"))).toEqual([
          { type: "select", id: "gateway-2" },
          { type: "open-window", id: "gateway-3" },
          { type: "open-settings" },
        ]);
      },
    ));

  it("keeps Get the apps available in a browser", async () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { sessions: [], historyMessages: [] });
      await page.goto(`${suite.server.baseUrl}new`);
      await waitForControlUiGatewayReady(page);
      const menu = await openMenu(page);
      await menu.locator('[data-value="command:apps"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/apps");
    }));
});
