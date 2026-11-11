import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  pauseVirtualClock,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { expectText, expectCount, seedStorage } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();

function treeList(parentKey: string, roots: unknown[], children: unknown[]) {
  return {
    cases: [
      { match: { spawnedBy: parentKey }, response: sessionsListResponse(children) },
      { response: sessionsListResponse(roots) },
    ],
  };
}

function withPage(run: (page: Page) => Promise<void>, options: BrowserContextOptions = {}) {
  return suite.withPage({ ...createControlUiE2eContextOptions(), ...options }, async ({ page }) => {
    await page.clock.install();
    await run(page);
  });
}

async function invalidateSessions(page: Page, gateway: MockGatewayControls, payload: unknown) {
  await pauseVirtualClock(page);
  await gateway.emitGatewayEvent("sessions.changed", payload);
  await page.clock.fastForward(5_001);
  await page.clock.resume();
}

async function deferChildRefresh(
  page: Page,
  gateway: MockGatewayControls,
  parentKey: string,
  updatedAt: number,
) {
  const match = { spawnedBy: parentKey };
  const after = (await gateway.getRequests("sessions.list", match)).length;
  expect(after).toBeGreaterThan(0);
  await gateway.deferNext("sessions.list", match);
  await invalidateSessions(page, gateway, {
    key: parentKey,
    sessionKey: parentKey,
    reason: "run",
    updatedAt,
  });
  await gateway.waitForRequest("sessions.list", { after, match });
}

suite.define(() => {
  it.each([
    { colorScheme: "dark", pointer: "fine", textScale: 100, width: 1440 },
    { colorScheme: "light", pointer: "fine", textScale: 100, width: 1440 },
    { colorScheme: "dark", pointer: "fine", textScale: 100, width: 390 },
    { colorScheme: "light", pointer: "fine", textScale: 100, width: 390 },
    { colorScheme: "dark", pointer: "coarse", textScale: 100, width: 390 },
    { colorScheme: "light", pointer: "coarse", textScale: 100, width: 390 },
    { colorScheme: "dark", pointer: "fine", textScale: 140, width: 1440 },
  ] as const)(
    "keeps $colorScheme child rows stable through loading and refresh at $width px with a $pointer pointer and $textScale% text",
    async ({ colorScheme, pointer, textScale, width }) => {
      const baseTime = Date.parse("2026-09-04T12:00:00.000Z");
      const activeKey = "agent:main:loading-active";
      const parentKey = "agent:main:loading-parent";
      const childKey = "agent:main:loading-child";
      const activeRow = sessionRow(activeKey, "Active session", baseTime + 1);
      const parentRow = sessionRow(parentKey, "Research handoff", baseTime, {
        childSessions: [childKey],
      });
      const childRow = sessionRow(childKey, "Background research", baseTime - 1, {
        spawnedBy: parentKey,
      });
      await withPage(
        async (page) => {
          if (textScale !== 100) {
            await seedStorage(page, {
              [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
                textScale,
              }),
            });
          }
          const gateway = await installMockGateway(page, {
            sessions: [activeRow, parentRow, childRow],
            methodResponses: {
              "sessions.list": treeList(parentKey, [activeRow, parentRow], [childRow]),
            },
            sessionKey: activeKey,
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
          expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(
            pointer === "coarse",
          );
          if (width === 390) {
            const drawerToggle = navigationDrawerToggle(page);
            await drawerToggle.waitFor({ state: "visible" });
            await drawerToggle.click();
          }
          const childToggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
          await childToggle.waitFor({ state: "visible" });
          if (width === 390) {
            const parent = page.locator(`[data-session-key="${parentKey}"]`);
            const menu = parent.locator("[data-sidebar-session-menu]");
            const toggleBox = (await childToggle.boundingBox())!;
            const menuBox = (await menu.boundingBox())!;
            expect(menuBox).toMatchObject({ width: 36, height: 44 });
            expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(menuBox.x);
            for (const control of [childToggle, menu]) {
              expect(
                await control.evaluate((element) => {
                  const box = element.getBoundingClientRect();
                  return element.contains(
                    document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
                  );
                }),
              ).toBe(true);
            }
          }
          await gateway.deferNext("sessions.list", { spawnedBy: parentKey });
          await childToggle.click();
          await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parentKey } });

          const children = page.locator(
            `[data-session-tree="${parentKey}"] > .sidebar-session-tree__children`,
          );
          const loading = children.locator(":scope > .sidebar-session-tree__loading");
          await expectCount(loading, 1);
          expect(await children.locator(":scope > .skeleton").count()).toBe(1);
          expect(await loading.getAttribute("aria-busy")).toBe("true");
          expect(await loading.getAttribute("aria-label")).toBe("Loading…");
          expect(
            await loading
              .locator("a, button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
              .count(),
          ).toBe(0);
          const loadingGeometry = await loading.evaluate((element) => ({
            left: element.getBoundingClientRect().left,
            rowHeight: element.parentElement!.getBoundingClientRect().height,
          }));
          if (textScale === 100) {
            expect(loadingGeometry.rowHeight).toBe(width === 390 ? 44 : 32);
          } else {
            expect(loadingGeometry.rowHeight).toBeGreaterThan(30);
          }

          await gateway.resolveDeferred("sessions.list");
          await expectCount(loading, 0);
          const child = page.locator(`[data-session-key="${childKey}"]`);
          await child.waitFor({ state: "visible" });
          const childGeometry = await child.evaluate((element) => ({
            left: element.querySelector(".sidebar-recent-session__name")!.getBoundingClientRect()
              .left,
            rowHeight: element.parentElement!.parentElement!.getBoundingClientRect().height,
          }));
          expect(childGeometry.left).toBe(loadingGeometry.left);
          // Chromium can quantize empty and text line boxes 1/64 CSS px apart.
          expect(childGeometry.rowHeight).toBeCloseTo(loadingGeometry.rowHeight, 1);

          await deferChildRefresh(page, gateway, parentKey, baseTime + 2);
          expect(await page.locator(".sidebar-session-tree__loading").count()).toBe(0);
          expect(await child.isVisible()).toBe(true);

          await gateway.resolveDeferred(
            "sessions.list",
            sessionsListResponse([
              { ...childRow, label: "Updated research", updatedAt: baseTime + 3 },
            ]),
          );
          await expectText(child, "Updated research");
          expect(await page.locator(".sidebar-session-tree__loading").count()).toBe(0);
          expect(await child.count()).toBe(1);
        },
        {
          colorScheme,
          hasTouch: pointer === "coarse",
          isMobile: pointer === "coarse",
          reducedMotion: width === 390 ? "reduce" : "no-preference",
          viewport: { height: 900, width },
        },
      );
    },
  );
});
