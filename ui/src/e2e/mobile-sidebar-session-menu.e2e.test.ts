import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const menuItem = (root: Page | Locator, name: string) =>
  root.getByRole("menuitem", { name, exact: true });
const noNestedMenus = async (root: Page | Locator) =>
  expect(await root.locator(".session-menu__panel [role='menu']").count()).toBe(0);
const part = (row: Locator, name: string) => row.locator(`.sidebar-recent-session__${name}`);
const widthOf = (item: Locator) =>
  item.evaluate((element) => element.getBoundingClientRect().width);
const pageOptions = (width: number, height: number, hasTouch: boolean): BrowserContextOptions => ({
  colorScheme: "dark",
  hasTouch,
  viewport: { width, height },
});
async function box(item: Locator) {
  const bounds = await item.boundingBox();
  expect(bounds, `visible bounds for ${item.toString()}`).not.toBeNull();
  return bounds!;
}

async function openDrawer(page: Page, wait = false) {
  const toggle = navigationDrawerToggle(page);
  if (wait) {
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
  }
  await toggle.click();
  await waitForMobileSidebarDrawerOpen(page);
}

type Box = { x: number; y: number; width: number; height: number };
function expectHorizontalBounds(inner: Pick<Box, "x" | "width">, outer: Pick<Box, "x" | "width">) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
}

function expectVerticalBounds(inner: Pick<Box, "y" | "height">, outer: Pick<Box, "y" | "height">) {
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

function expectVerticalOverlap(first: Box, second: Box) {
  expect(first.y).toBeLessThanOrEqual(second.y + second.height);
  expect(first.y + first.height).toBeGreaterThanOrEqual(second.y);
}

async function expectSessionGeometry(row: Locator, multiline = false) {
  const button = await box(row.locator("[data-sidebar-session-menu]"));
  const bounds = await box(row);
  const title = await box(part(row, "name"));
  expect(title.x + title.width).toBeLessThanOrEqual(button.x);
  expectVerticalOverlap(button, title);
  if (multiline) {
    expect(button.width).toBeCloseTo(44, 4);
    expect(button.height).toBeCloseTo(44, 4);
    expect(title.x).toBeGreaterThanOrEqual(bounds.x);
    expectVerticalBounds(button, bounds);
  } else {
    expectHorizontalBounds(button, bounds);
    expect(button.width).toBe(44);
    expect(bounds.height).toBeCloseTo(44, 1);
  }
}

suite.define(() => {
  it.each(["coarse", "fine"] as const)(
    "keeps shortcut menus, colored session glyphs, and section labels usable in a %s pointer layout",
    async (pointer) => {
      await suite.withPage(pageOptions(390, 844, pointer === "coarse"), async ({ page }) => {
        const pinnedKey = "agent:main:release-plan";
        const groupedKey = "agent:main:review-notes";
        const gateway = await installMockGateway(page, {
          sessionKey: groupedKey,
          sessionGroups: ["Research", "Operations"],
          sessions: [
            sessionRow(pinnedKey, "Release planning", 3, { icon: "📌", color: "blue" }),
            sessionRow(groupedKey, "Review notes", 2, {
              category: "Research",
              icon: "🔬",
              color: "purple",
            }),
            sessionRow("agent:main:follow-up", "Follow-up", 1, { category: "Operations" }),
          ],
          controlUiTabs: [
            { id: "reports", pluginId: "reports", label: "Reports", icon: "chartBar" },
          ],
        });
        // Bind the UI to the same Gateway origin as the seeded preferences.
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        await page.addInitScript(
          ({ key, gatewayUrl, railShortcuts }) => {
            localStorage.setItem(`openclaw.control.currentGateway.v1:${gatewayUrl}`, gatewayUrl);
            localStorage.setItem(key, JSON.stringify({ railShortcuts }));
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
            railShortcuts: ["route:cron", "route:sessions", "plugin:reports/reports"],
          },
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, groupedKey));
        await openDrawer(page);
        const rail = page.locator(".sidebar-rail");
        const pinned = rail.locator('[data-sidebar-entry="route:sessions"]');
        const plugin = rail.locator('[data-sidebar-entry="plugin:reports/reports"]');
        const session = page.locator(
          '.sidebar-session-content .sidebar-recent-session[data-session-key="agent:main:release-plan"]',
        );
        const group = page.locator('[data-session-section="category:Research"]');
        await pinned.locator(".nav-item__icon").waitFor();
        await plugin.locator(".nav-item__icon").waitFor();
        await group.locator(".sidebar-recent-session").waitFor();
        await session.waitFor();
        // Rail pins are flat navigation refs; sessions and their actions stay in Sessions.
        expect(await rail.locator(".sidebar-recent-session").count()).toBe(0);
        for (const width of [320, 390, 768]) {
          await page.setViewportSize({ width, height: 844 });
          expect((await rail.boundingBox())?.width).toBe(52);
          for (const row of [pinned, plugin]) {
            const shortcut = row.getByRole("link");
            await row.hover();
            const [button, glyph] = await Promise.all([
              box(shortcut),
              box(row.locator(".session-glyph, .nav-item__icon").first()),
            ]);
            expect(button.width).toBeGreaterThanOrEqual(32);
            expect(button.height).toBeGreaterThanOrEqual(32);
            expectHorizontalBounds(glyph, button);
            expectVerticalBounds(glyph, button);
          }
          await expectSessionGeometry(session);
          for (const colored of [session, group.locator(".sidebar-recent-session")]) {
            const clearance = await colored.evaluate((row) => {
              const stripe = getComputedStyle(row, "::before");
              const glyph = row.querySelector(".session-glyph")!.getBoundingClientRect();
              const stripeRight = Number.parseFloat(stripe.left) + Number.parseFloat(stripe.width);
              return glyph.left - row.getBoundingClientRect().left - stripeRight;
            });
            expect(clearance).toBeGreaterThanOrEqual(2);
          }
        }
        const toggle = group.locator(".sidebar-session-group-toggle");
        await toggle.click();
        await group.locator(".sidebar-recent-session").waitFor({ state: "hidden" });
        await toggle.click();
        await group.locator(".sidebar-recent-session").waitFor();
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect(await gateway.getRequests("config.patch")).toEqual([]);
      });
    },
  );

  it.each(["coarse", "fine"] as const)(
    "keeps mobile sidebar titles and menus usable with a %s pointer",
    async (pointer) => {
      const sessionKey = "agent:main:mobile-sidebar-menu";
      const plainKey = "agent:main:mobile-sidebar-long-title";
      const privateKey = "agent:main:mobile-sidebar-private";
      const overflowGroups = Array.from({ length: 24 }, (_, index) => `Team ${index + 1}`);
      await suite.withPage(pageOptions(390, 650, pointer === "coarse"), async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
        });
        await installMockGateway(page, {
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(sessionKey, "Mobile sidebar menu", Date.UTC(2026, 7, 19, 3), {
                category: "Research",
                lastMessagePreview: "Keep this second line visible during navigation",
              }),
              sessionRow(plainKey, "Investigate mobile sidebar title readability", 1, {
                category: "Research",
                color: "blue",
              }),
              sessionRow(privateKey, "Private planning and follow-up tasks", 0, {
                category: "Research",
                incognito: true,
              }),
            ]),
          },
          sessionGroups: ["Research", "Operations", "Planning", ...overflowGroups],
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await openDrawer(page, true);

        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        await part(row, "subtitle").waitFor({ state: "visible" });
        expect(await row.getAttribute("class")).not.toContain(
          "sidebar-recent-session--single-line",
        );
        const title = part(row, "name");
        const titleWidth = () => widthOf(title);
        const restingWidth = await titleWidth();
        await page.mouse.move(389, 649);
        // Keep the drawer increase modest; reclaim reading space inside its rows.
        const drawerBox = await page.locator(".shell-nav").boundingBox();
        expect(drawerBox?.width).toBeGreaterThanOrEqual(330);
        expect(drawerBox?.width).toBeLessThanOrEqual(336);
        // Reserve one 44px menu target without starving the title beside the rail.
        expect(restingWidth).toBeGreaterThanOrEqual(180);
        const plainRow = page.locator(`[data-session-key="${plainKey}"]`);
        const plainTitle = part(plainRow, "name");
        await plainTitle.waitFor({ state: "visible" });
        expect(await widthOf(plainTitle)).toBeCloseTo(restingWidth, 1);
        expect(await part(plainRow, "details").isVisible()).toBe(false);
        await page
          .locator(`[data-session-key="${privateKey}"] .session-row-badge--incognito`)
          .waitFor({ state: "visible" });
        if (pointer === "fine") {
          await row.hover();
          expect(await titleWidth()).toBeCloseTo(restingWidth, 1);
          await page.mouse.move(389, 649);
          await part(row, "link").focus();
          expect(await titleWidth()).toBeCloseTo(restingWidth, 1);
        }
        expect(await row.locator("[data-sidebar-session-pin]").isVisible()).toBe(false);
        expect(await row.locator("[data-sidebar-session-archive]").isVisible()).toBe(false);
        const menuButton = row.locator("[data-sidebar-session-menu]");
        // Allow only roundoff from the drawer's translated box coordinates.
        await expectSessionGeometry(row, true);
        // Empty metadata must not reserve a second row just for the menu.
        expect((await box(plainRow)).height).toBeCloseTo(44, 1);
        expect(
          await plainTitle.evaluate((element) => ({
            clipped: element.scrollWidth > element.clientWidth,
            overflow: getComputedStyle(element).textOverflow,
            mask: getComputedStyle(element).maskImage,
          })),
        ).toEqual({ clipped: true, overflow: "ellipsis", mask: "none" });
        await (pointer === "coarse" ? menuButton.tap() : menuButton.click());

        const menu = page.getByRole("menu", { name: "Actions for Mobile sidebar menu" });
        await menu.waitFor({ state: "visible" });
        await menuItem(page, "Pin session").waitFor();
        await menuItem(page, "Archive session").waitFor();

        await noNestedMenus(page.locator("openclaw-session-menu"));
        await page.getByRole("menuitem", { name: "Move to group" }).click();
        const back = page.getByRole("menuitem", { name: "Back" });
        await back.waitFor({ state: "visible" });
        await page.getByRole("menuitemradio", { name: "Operations" }).waitFor({ state: "visible" });
        await noNestedMenus(page.locator("openclaw-session-menu"));
        const menuBox = await box(menu);
        expectHorizontalBounds(menuBox, { x: 8, width: 374 });
        expectVerticalBounds(menuBox, { y: 8, height: 634 });
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
        expectVerticalBounds(await box(back), menuBox);
      });
    },
  );
});
