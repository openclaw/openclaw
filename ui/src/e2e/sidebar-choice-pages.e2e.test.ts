import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import { captureFrame, catalogList, expectFocused } from "./sidebar-assertions.test-support.ts";
import { settleSidebarMenuMotion } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar choice pages" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = capture ? createControlUiE2eArtifactDir("sidebar-choice-pages") : undefined;
const viewports = [
  { width: 390, height: 844, colorScheme: "dark" },
  { width: 820, height: 1000, colorScheme: "light" },
  { width: 1400, height: 1000, colorScheme: "dark" },
] as const;
const people = Array.from({ length: 30 }, (_, index) => ({
  id: `person-${index}`,
  identity: { type: "profile" as const, id: `person-${index}` },
  name: index === 0 ? "Ada Chen" : `Release reviewer ${String(index).padStart(2, "0")}`,
  self: index === 0,
}));

suite.define(() => {
  it.each(viewports)(
    "shows the complete People sort page and restores root focus at $width",
    async ({ width, height, colorScheme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme, reducedMotion: "reduce" },
        async ({ page }) => {
          await installMockGateway(page, { presenceUsers: people });
          await page.goto(suite.server.baseUrl + "new");
          if (width < 1000) {
            await navigationDrawerToggle(page).click();
          }
          await page.locator('[data-navigation-view="online"]').click();
          const trigger = page.locator(".sidebar-online__filter-toggle");
          await trigger.click();
          const root = page.locator(".sidebar-people-filter-menu");
          const sort = root.locator("#sidebar-people-sort");
          await sort.click();
          const list = root.getByRole("listbox", { name: "Sort by", exact: true });
          const name = list.getByRole("option", { name: "Name", exact: true });
          await name.waitFor();
          await settleSidebarMenuMotion(list);
          if (artifactDir) {
            await captureFrame(
              artifactDir,
              `people-${width}.png`,
              root.locator(".sidebar-session-filter-panel"),
              [list],
            );
          }
          expect(await list.getByRole("option").allTextContents()).toHaveLength(4);
          expect(
            await list.evaluate((element) => element.scrollHeight - element.clientHeight),
          ).toBeLessThanOrEqual(1);
          if (width < 1000) {
            await root.getByRole("button", { name: "Back", exact: true }).click();
            await expectFocused(sort);
            await sort.click();
          }
          if (width < 1000) {
            await name.waitFor();
            await page.setViewportSize({ width, height: 160 });
            const bounds = (await root.locator(".sidebar-session-filter-panel").boundingBox())!;
            expect(bounds.y).toBeGreaterThanOrEqual(0);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(160);
            expect(
              await list.evaluate((element) => element.scrollHeight - element.clientHeight),
            ).toBeGreaterThan(1);
            await name.scrollIntoViewIfNeeded();
          }
          await name.click();
          await page.setViewportSize({ width, height });
          await expect.poll(() => root.count()).toBe(0);
          await expectFocused(trigger);
          await trigger.click();
          expect(await root.locator("#sidebar-people-sort").textContent()).toContain("Name");
          await page.keyboard.press("Escape");
          await page.locator('[data-navigation-view="sessions"]').click();
          await page.locator(".sidebar-panel-header .sidebar-session-sort").click();
          const sessions = page.locator(".sidebar-session-sort-menu");
          const panel = sessions.locator(".sidebar-session-filter-panel");
          await settleSidebarMenuMotion(panel);
          const originalHeight = (await panel.boundingBox())!.height;
          await sessions.locator("#sidebar-sessions-group").click();
          await sessions.getByRole("option", { name: "None", exact: true }).waitFor();
          if (width < 1000) {
            await sessions.getByRole("button", { name: "Back", exact: true }).click();
          } else {
            await page.keyboard.press("Escape");
          }
          expect((await panel.boundingBox())!.height).toBeCloseTo(originalHeight, 0);
        },
      );
    },
  );

  it.each(viewports.filter(({ width }) => width < 1000))(
    "bounds catalog owner navigation and keeps a long roster usable at $width",
    async ({ width, height, colorScheme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme, reducedMotion: "reduce" },
        async ({ page }) => {
          await installMockGateway(page, {
            presenceUsers: people,
            operatorScopes: ["operator.read", "operator.write"],
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
            methodResponses: {
              "sessions.list": {
                ...sessionsListResponse([]),
                owners: people.map((person) => ({
                  type: "human",
                  id: person.id,
                  label: person.name,
                })),
              },
              "sessions.catalog.list": catalogList({
                archive: false,
                id: "cli-tools",
                label: "CLI tools",
                host: "Workstation",
                thread: "cli-thread",
                name: "Release planning",
                status: "stored",
              }),
            },
          });
          await page.goto(suite.server.baseUrl + "new");
          await navigationDrawerToggle(page).click();
          await page.locator('[data-navigation-view="sessions"]').click();
          await page.locator("#sidebar-session-owner-title").click();
          await page
            .locator(".sidebar-session-owner-filter")
            .getByRole("option", { name: "All owners", exact: true })
            .click();
          await page
            .locator('[data-session-section="catalog:cli-tools"] .sidebar-recent-sessions__head')
            .first()
            .click({ button: "right" });
          const row = page.locator('[data-value="compact:open-specific-owner"]');
          await row.waitFor();
          if (artifactDir) {
            await captureFrame(
              artifactDir,
              `catalog-${width}.png`,
              page.locator(".sidebar-catalog-view-menu"),
              [row],
            );
          }
          expect((await row.locator("svg").boundingBox())!.width).toBeLessThanOrEqual(16);
          expect(
            await row
              .locator(".session-menu__text")
              .evaluate((element) => element.scrollWidth - element.clientWidth),
          ).toBeLessThanOrEqual(1);
          await row.click();
          const back = page.locator('[data-value="compact:back"]');
          await back.waitFor();
          await back.click();
          await row.waitFor();
          await row.click();
          await page.setViewportSize({ width, height: 320 });
          const last = page.locator('[data-value="owner:person-29"]');
          await last.scrollIntoViewIfNeeded();
          await last.click();
          await expect.poll(() => page.locator(".sidebar-catalog-view-menu").count()).toBe(0);
        },
      );
    },
  );
});
