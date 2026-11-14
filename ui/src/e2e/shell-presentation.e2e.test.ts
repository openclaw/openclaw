import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Shell presentation continuity" });
const variants = [
  { width: 1440, height: 900, colorScheme: "light" },
  { width: 1440, height: 900, colorScheme: "dark" },
  { width: 390, height: 844, colorScheme: "light" },
  { width: 390, height: 844, colorScheme: "dark" },
] as const;

suite.define(() =>
  it.each(variants)(
    "preserves shell and draft ($width px, $colorScheme)",
    ({ width, height, colorScheme }) =>
      suite.withPage(
        {
          viewport: { width, height },
          colorScheme,
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}new`);
          await waitForControlUiRoute(page, { routeId: "new-session" });
          const shell = page.locator(".shell");
          const sidebar = page.locator("openclaw-app-sidebar");
          expect(await sidebar.count()).toBe(1);
          const sidebarNode = await sidebar.elementHandle();
          if (!sidebarNode) {
            throw new Error("expected sidebar element");
          }
          const assertSidebarIdentity = async () => {
            expect(await sidebar.count()).toBe(1);
            expect(
              await page.evaluate(
                (original) => document.querySelector("openclaw-app-sidebar") === original,
                sidebarNode,
              ),
            ).toBe(true);
          };
          const navigationToggle =
            width < 900
              ? navigationDrawerToggle(page)
              : page.locator('[data-navigation-view][aria-pressed="true"]:visible');
          await navigationToggle.click();
          const collapsedClass = width < 900 ? "shell--nav-drawer-open" : "shell--nav-collapsed";
          await page.locator(`.${collapsedClass}`).waitFor();
          if (width < 900) {
            await page.keyboard.press("Escape");
          } else {
            await page.locator('[data-navigation-view="sessions"]').click();
          }
          await expect.poll(() => shell.getAttribute("class")).not.toContain(collapsedClass);
          await assertSidebarIdentity();

          await page.evaluate(() => window.openclawControlUi?.navigate("chat"));
          await waitForControlUiRoute(page, { routeId: "chat" });
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          const draft = "Keep this synthetic draft through connection recovery.";
          await composer.fill(draft);
          await assertSidebarIdentity();
          const connectCount = await gateway.deferNext("connect");
          await gateway.setOnline(false);
          await page.locator(".agent-chat__input--offline").waitFor();
          expect(await composer.inputValue()).toBe(draft);
          await gateway.setOnline(true);
          await gateway.waitForRequest("connect", { after: connectCount });
          await page.waitForFunction(
            () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
          );
          await gateway.resolveDeferred("connect");
          await page.waitForFunction(() => {
            const state = window.openclawControlUi?.snapshot();
            return state?.gatewayPhase === "connected" && state.ready;
          });
          expect(await composer.inputValue()).toBe(draft);
          await assertSidebarIdentity();
          await sidebarNode.dispose();

          await page.goto(`${suite.server.baseUrl}new?onboarding=1`);
          await page.locator(".shell--onboarding").waitFor();
          await waitForControlUiRoute(page, { routeId: "new-session" });
          expect(await page.locator(".shell-nav:visible").count()).toBe(0);
        },
      ),
  ),
);
