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
  captureUiProof,
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
  it("never paints a gap or overlap below an expanded chat tree", async () => {
    const parent = "agent:main:dashboard:release";
    const following = "agent:main:dashboard:publish";
    const kids = Array.from({ length: 4 }, (_, i) =>
      sessionRow("agent:main:dashboard:check-" + i, "Review notes " + (i + 1), 20 - i, {
        spawnedBy: parent,
        parentSessionKey: parent,
        createdAt: 20 - i,
      }),
    );
    const roots = [
      sessionRow(parent, "Release notes", 100, {
        createdAt: 100,
        childSessions: kids.map((c) => c.key),
      }),
      sessionRow(following, "Publish notes", 90, { createdAt: 90 }),
    ];
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await seedStorage(page, {
        "openclaw:sidebar:sessions:sort-mode": "created",
        [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
          textScale: 140,
        }),
      });
      await installMockGateway(page, {
        sessions: [...roots, ...kids],
        sessionKey: following,
        methodResponses: { "sessions.list": treeList(parent, roots, kids) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, following));
      const toggle = page.locator('[data-child-session-toggle="' + parent + '"]');
      await toggle.waitFor();
      const next = page.locator('[data-session-key="' + following + '"]');
      await next.waitFor();
      const probe = await next.evaluateHandle((el, parentKey) => {
        const group = document.querySelector('[data-session-tree="' + parentKey + '"]')!;
        const seen: Array<{ gap: number; children: number }> = [];
        let frame = 0;
        const measure = () => {
          const gap = Number(
            (el.getBoundingClientRect().top - group.getBoundingClientRect().bottom).toFixed(2),
          );
          const children = group.querySelectorAll(".sidebar-recent-session--child").length;
          const last = seen.at(-1);
          if (last?.gap !== gap || last.children !== children) {
            seen.push({ gap, children });
          }
          frame = requestAnimationFrame(measure);
        };
        measure();
        return () => {
          cancelAnimationFrame(frame);
          return seen;
        };
      }, parent);
      for (let cycle = 0; cycle < 3; cycle++) {
        await toggle.click();
        await expectCount(page.locator(".sidebar-recent-session--child"), 4);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await toggle.click();
        await expectCount(page.locator(".sidebar-recent-session--child"), 0);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
      }
      const samples = await probe.evaluate((stop) => stop());
      expect(samples.some((s) => s.children === 4)).toBe(true);
      expect(
        samples.filter((s) => Math.abs(s.gap) > 1),
        JSON.stringify(samples),
      ).toEqual([]);
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
      const activeRow = sessionRow(activeKey, "Active session", baseTime - 4, {
        createdAt: baseTime - 4,
      });
      const parentRow = sessionRow(parentKey, "Research handoff", baseTime, {
        createdAt: baseTime,
        childSessions: [childKey],
      });
      const childRow = sessionRow(childKey, "Background research", baseTime - 1, {
        createdAt: baseTime - 1,
        spawnedBy: parentKey,
        hasActiveRun: true,
        status: "running",
        startedAt: baseTime,
      });
      await withPage(
        async (page) => {
          // Isolate unrequested movement from the Updated sort intentionally reordering roots.
          await seedStorage(page, { "openclaw:sidebar:sessions:sort-mode": "created" });
          await page.clock.setFixedTime(baseTime + 9_000);
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
          await page.mouse.move(width - 5, 5);
          await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parentKey } });

          const children = page.locator(
            `[data-session-tree="${parentKey}"] > .sidebar-session-tree__children`,
          );
          // A read is not a chat. Announce it without borrowing a row from the list.
          expect(await childToggle.getAttribute("aria-busy")).toBe("true");
          expect(await children.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
          const proof = (state: string) =>
            captureUiProof(
              suite,
              page,
              ["child", state, colorScheme, width, pointer, textScale].join("-") + ".png",
            );
          await proof("loading");
          await gateway.resolveDeferred("sessions.list");
          const child = page.locator('[data-session-key="' + childKey + '"]');
          await child.waitFor();
          const retained = await child.elementHandle();
          const geometry = () =>
            child.evaluate((el) => {
              const title = el.querySelector(".sidebar-recent-session__name")!;
              const { x, y, width: titleWidth, height } = title.getBoundingClientRect();
              return [x, y, titleWidth, height, el.getBoundingClientRect().height];
            });
          const running = await geometry();
          const frameProbe = await child.evaluateHandle((el) => {
            const title = el.querySelector(".sidebar-recent-session__name")!;
            const origin = title.getBoundingClientRect();
            let shifted = false;
            let frame = 0;
            const sample = () => {
              const rect = title.getBoundingClientRect();
              shifted ||= !el.isConnected || rect.x !== origin.x || rect.y !== origin.y;
              frame = requestAnimationFrame(sample);
            };
            sample();
            return () => {
              cancelAnimationFrame(frame);
              return shifted;
            };
          });
          expect(await child.locator("openclaw-elapsed-time").count()).toBe(0);
          expect(await childToggle.getAttribute("aria-busy")).toBeNull();
          await proof("running");

          await deferChildRefresh(page, gateway, parentKey, baseTime + 2);
          expect(await page.locator(".sidebar-session-tree__loading").count()).toBe(0);
          expect(await child.isVisible()).toBe(true);

          await gateway.resolveDeferred(
            "sessions.list",
            sessionsListResponse([
              {
                ...childRow,
                label: "Updated research",
                updatedAt: baseTime + 3,
                hasActiveRun: false,
                status: "done",
              },
            ]),
          );
          await expectText(child, "Updated research");
          expect(await page.locator(".sidebar-session-tree__loading").count()).toBe(0);
          expect(await child.count()).toBe(1);
          expect(await geometry()).toEqual(running);
          expect(await retained?.evaluate((el) => el.isConnected)).toBe(true);
          expect(await child.locator('[aria-label="Done"]').count()).toBe(0);
          await proof("finished");

          if (width === 1440 && textScale === 100 && colorScheme === "dark") {
            const sibling = sessionRow(
              "agent:main:verification",
              "Verify citations",
              baseTime - 2,
              { spawnedBy: parentKey, createdAt: baseTime - 2 },
            );
            const siblingRow = page.locator('[data-session-key="agent:main:verification"]');
            const settled = {
              ...childRow,
              label: "Updated research",
              status: "done",
              hasActiveRun: false,
              updatedAt: baseTime + 3,
            };
            for (const present of [true, false]) {
              await deferChildRefresh(page, gateway, parentKey, baseTime + (present ? 4 : 5));
              await gateway.resolveDeferred(
                "sessions.list",
                sessionsListResponse(present ? [settled, sibling] : [settled]),
              );
              await expectCount(siblingRow, Number(present));
              expect(await retained?.evaluate((el) => el.isConnected)).toBe(true);
              expect(await geometry()).toEqual(running);
              await proof(present ? "sibling-added" : "sibling-removed");
            }
          }
          expect(await frameProbe.evaluate((stop) => stop())).toBe(false);
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
