import { expect, it } from "vitest";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it.each(["coarse", "fine"] as const)(
    "keeps mobile sidebar titles and menus usable with a %s pointer",
    async (pointer) => {
      const sessionKey = "agent:main:mobile-sidebar-menu";
      const context = await suite.browser.newContext({
        colorScheme: "dark",
        hasTouch: pointer === "coarse",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 650, width: 390 },
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
      });
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Mobile sidebar menu", Date.parse("2026-08-19T03:00:00.000Z"), {
              category: "Research",
              lastMessagePreview: "Keep this second line visible during navigation",
            }),
          ]),
        },
        sessionGroups: [
          "Research",
          "Operations",
          "Planning",
          ...Array.from({ length: 24 }, (_, index) => `Team ${index + 1}`),
        ],
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const drawerToggle = page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first();
        await drawerToggle.waitFor({ state: "visible", timeout: 10_000 });
        await drawerToggle.click();

        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await row.locator(".sidebar-recent-session__subtitle").waitFor({ state: "visible" });
        expect(await row.getAttribute("class")).not.toContain(
          "sidebar-recent-session--single-line",
        );
        const title = row.locator(".sidebar-recent-session__name");
        const titleWidth = () => title.evaluate((element) => element.getBoundingClientRect().width);
        const restingWidth = await titleWidth();
        if (pointer === "fine") {
          await row.hover();
          expect(await titleWidth()).toBeCloseTo(restingWidth, 1);
          await page.mouse.move(389, 649);
          await row.locator(".sidebar-recent-session__link").focus();
          expect(await titleWidth()).toBeCloseTo(restingWidth, 1);
        }
        expect(await row.locator("[data-sidebar-session-pin]").isVisible()).toBe(false);
        expect(await row.locator("[data-sidebar-session-archive]").isVisible()).toBe(false);
        const menuButton = row.locator("[data-sidebar-session-menu]");
        const buttonBox = await menuButton.boundingBox();
        const rowBox = await row.boundingBox();
        if (!buttonBox || !rowBox) {
          throw new Error("expected visible sidebar row and menu target");
        }
        expect(buttonBox).toMatchObject({ width: 44, height: 44 });
        expect(buttonBox.y).toBeGreaterThanOrEqual(rowBox.y);
        expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
        if (pointer === "coarse") {
          await menuButton.tap();
        } else {
          await menuButton.click();
        }

        const menu = page.getByRole("menu", { name: "Actions for Mobile sidebar menu" });
        await menu.waitFor({ state: "visible" });
        await page.getByRole("menuitem", { name: "Pin session", exact: true }).waitFor();
        await page.getByRole("menuitem", { name: "Archive session", exact: true }).waitFor();
        await captureUiProof(suite, page, "mobile-sidebar-session-menu-after-root.png");

        expect(await page.locator("openclaw-session-menu [slot='submenu']").count()).toBe(0);
        await page.getByRole("menuitem", { name: "Move to group" }).click();
        const back = page.getByRole("menuitem", { name: "Back" });
        await back.waitFor({ state: "visible" });
        await page.getByRole("menuitemradio", { name: "Operations" }).waitFor({ state: "visible" });
        expect(await page.locator("openclaw-session-menu [slot='submenu']").count()).toBe(0);
        const menuBox = await menu.boundingBox();
        if (!menuBox) {
          throw new Error("expected visible compact sidebar session menu");
        }
        expect(menuBox.x).toBeGreaterThanOrEqual(8);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(382);
        expect(menuBox.y).toBeGreaterThanOrEqual(8);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(642);
        const scroll = await menu.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          };
        });
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        expect(scroll.scrollTop).toBeGreaterThan(0);
        const backBox = await back.boundingBox();
        if (!backBox) {
          throw new Error("expected sticky Back action bounds");
        }
        expect(backBox.y).toBeGreaterThanOrEqual(menuBox.y);
        expect(backBox.y + backBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height);
        await captureUiProof(suite, page, "mobile-sidebar-session-menu-after-group-drilldown.png");
      } catch (error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: "mobile-sidebar-session-menu",
        });
        throw error;
      } finally {
        await context.close();
      }
    },
  );
});
