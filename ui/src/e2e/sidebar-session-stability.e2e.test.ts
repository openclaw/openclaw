import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  pauseVirtualClock,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import {
  expectPath,
  expectText,
  expectAttribute,
  expectCount,
  seedStorage,
} from "./sidebar-assertions.test-support.ts";

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
  return suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...options,
    },
    async ({ page }) => {
      await page.clock.install();
      await run(page);
    },
  );
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
  it("refreshes the selected child after a later child-list result", async () => {
    const baseTime = Date.parse("2026-09-07T12:00:00.000Z");
    const parentKey = "agent:main:research-parent";
    const childKey = "agent:main:research-child";
    const siblingKey = "agent:main:research-sibling";
    const parentRow = sessionRow(parentKey, "Research handoff", baseTime, {
      childSessions: [childKey, siblingKey],
    });
    const childRow = sessionRow(childKey, "Research in progress", baseTime + 1, {
      spawnedBy: parentKey,
    });
    const siblingRow = sessionRow(siblingKey, "Supporting research", baseTime + 1, {
      spawnedBy: parentKey,
    });
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        sessions: [parentRow, childRow, siblingRow],
        methodResponses: {
          "sessions.list": treeList(parentKey, [parentRow], [childRow, siblingRow]),
        },
        sessionKey: childKey,
      });
      const documentResponse = await page.goto(controlUiSessionUrl(suite.server.baseUrl, childKey));
      expect(documentResponse?.status()).toBe(200);
      const child = page.locator(`[data-session-key="${childKey}"]`);
      const sibling = page.locator(`[data-session-key="${siblingKey}"]`);
      await expectText(child, "Research in progress");
      await expectText(sibling, "Supporting research");
      expect(await child.getAttribute("class")).toContain("sidebar-recent-session--active");
      const refreshedChildren = [childRow, siblingRow].map((row, index) => {
        const label = index === 0 ? "Research completed" : "Supporting research refreshed";
        return Object.assign({}, row, { label, displayName: label, updatedAt: baseTime + 3 });
      });
      // Commit the change before its invalidation event so every later read sees it.
      await gateway.setSessionsListResponse(
        sessionsListResponse([parentRow, ...refreshedChildren]),
      );
      await gateway.setMethodResponse(
        "sessions.list",
        treeList(parentKey, [parentRow], refreshedChildren),
      );
      await deferChildRefresh(page, gateway, parentKey, baseTime + 2);
      await gateway.resolveDeferred("sessions.list", sessionsListResponse(refreshedChildren));
      // The sibling proves the new child snapshot rendered before checking the selected row.
      await expectText(sibling, "Supporting research refreshed");
      expect(await child.textContent()).toContain("Research completed");
      expect(await child.textContent()).not.toContain("Research in progress");
      expect(await child.count()).toBe(1);
      expect(await child.getAttribute("class")).toContain("sidebar-recent-session--active");
    });
  });

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
            const drawerToggle = page
              .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
              .first();
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
            expect(menuBox).toMatchObject({ width: 44, height: 44 });
            expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(toggleBox.x);
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
            expect(loadingGeometry.rowHeight).toBe(width === 390 ? 44 : 30);
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

  it("keeps visible sessions ordered and an active child expanded across run completion", async () => {
    const baseTime = Date.parse("2026-08-14T18:00:00.000Z");
    const parentKey = "agent:main:stability-parent";
    const childKey = "agent:main:stability-child";
    const runId = "sidebar-stability-run";
    const siblingRows = Array.from({ length: 10 }, (_, index) =>
      sessionRow(`agent:main:stability-${index}`, `Stable session ${index}`, baseTime - index, {
        createdAt: baseTime - index,
      }),
    );
    const parentRow = sessionRow(parentKey, "Parent session", baseTime + 100, {
      childSessions: [childKey],
      createdAt: baseTime + 100,
    });
    const childRow = sessionRow(childKey, "Child session", baseTime + 50, {
      hasActiveRun: true,
      spawnedBy: parentKey,
      startedAt: baseTime,
      status: "running",
      activeRunIds: [runId],
      createdAt: baseTime + 50,
    });
    const expectedVisibleKeys = [
      parentKey,
      childKey,
      ...siblingRows.slice(0, 9).map(({ key }) => key),
    ];
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([parentRow, childRow, ...siblingRows]),
        },
        sessionKey: childKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, childKey));
      const rows = page.locator(".sidebar-recent-session");
      const visibleKeys = () =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-session-key")),
        );
      const childToggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      await expect.poll(visibleKeys, { timeout: 10_000 }).toEqual(expectedVisibleKeys);
      await expectAttribute(childToggle, "aria-expanded", "true");

      await gateway.emitGatewayEvent("agent", {
        data: { name: "bash" },
        runId,
        sessionKey: childKey,
        stream: "tool",
      });
      expect(await visibleKeys()).toEqual(expectedVisibleKeys);

      const completion = {
        activeRunIds: [],
        endedAt: baseTime + 200,
        hasActiveRun: false,
        status: "done",
        updatedAt: baseTime + 200,
      };
      const completedChild = { ...childRow, ...completion };
      await gateway.setSessionsListResponse(
        sessionsListResponse([parentRow, completedChild, ...siblingRows]),
      );
      const listCount = (await gateway.getRequests("sessions.list")).length;
      await invalidateSessions(page, gateway, {
        ...completion,
        key: childKey,
        kind: "direct",
        reason: "lifecycle",
        sessionKey: childKey,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listCount);
      await expect.poll(visibleKeys).toEqual(expectedVisibleKeys);

      const nextSessionKey = siblingRows[0]!.key;
      await page
        .locator(`[data-session-key="${nextSessionKey}"] a.sidebar-recent-session__link`)
        .click();
      await expectPath(page, controlUiSessionPath(nextSessionKey));
      await expectAttribute(childToggle, "aria-expanded", "true");
      await expect.poll(visibleKeys).toEqual(expectedVisibleKeys);
    });
  });
});
