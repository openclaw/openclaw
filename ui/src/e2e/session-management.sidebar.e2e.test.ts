import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { replaceGatewayClient } from "./new-session-page.test-support.ts";
import {
  actionOpacity,
  actionPointerEvents,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  trimmedTextContents,
} from "./session-management.test-support.ts";
import {
  expectAttribute,
  expectCount,
  expectText,
  expectVisible,
} from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const rosterMatch = { includeGlobal: true };
const rosterPreviewMatch = { ...rosterMatch, includeLastMessage: true };
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");

function ordinarySessions() {
  return [
    sessionRow("agent:main:main", "Main", baseTime),
    sessionRow("agent:main:research", "Research notes", baseTime - 3_600_000),
  ];
}

async function expectFocused(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((element) => element === document.activeElement))
    .toBe(true);
}

async function seedPersonalSessionPins(page: Page, keys: string[]) {
  await page.addInitScript(
    ({ storageKey, entries }) => {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      if (!Array.isArray(stored.railShortcuts)) {
        localStorage.setItem(storageKey, JSON.stringify({ ...stored, railShortcuts: entries }));
      }
    },
    {
      storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      entries: keys.map((key) => `session:${key}`),
    },
  );
}

function sessionActionPresentation(button: Locator) {
  return button.evaluate((element) => {
    const icon = element.querySelector("svg");
    if (!icon) {
      throw new Error("expected session action icon");
    }
    return {
      color: getComputedStyle(element).color,
      fill: getComputedStyle(icon).fill,
    };
  });
}

async function expectNoOverlappingRows(page: Page) {
  expect(
    await page.evaluate(() => {
      const rects = [
        ...document.querySelectorAll(".sidebar-recent-session, .sidebar-recent-sessions__head"),
      ]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        })
        .filter((rect) => rect.bottom > rect.top)
        .toSorted((a, b) => a.top - b.top);
      let bad = 0;
      let previousBottom: number | undefined;
      for (const rect of rects) {
        if (previousBottom !== undefined && rect.top < previousBottom - 2) {
          bad += 1;
        }
        previousBottom = rect.bottom;
      }
      return bad;
    }),
  ).toBe(0);
}

suite.define(() => {
  it.each([false, true])("nests spawned sessions (personal pin: %s)", async (pinned) => {
    const parentKey = "agent:main:release-plan";
    const childOneKey = "agent:main:research-sources";
    const childTwoKey = "agent:main:verify-tests";
    const staleRunningChildKey = "agent:main:stale-running";
    const failedChildKey = "agent:main:failed-checks";
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page, context }) => {
        const el = (selector: string) => page.locator(selector);

        const children = [
          sessionRow(childOneKey, "Research sources", baseTime - 1_000, {
            hasActiveRun: true,
            spawnedBy: parentKey,
            startedAt: baseTime - 61_000,
            status: "running",
          }),
          sessionRow(childTwoKey, "Verify tests", baseTime - 2_000, {
            endedAt: baseTime - 2_000,
            spawnedBy: parentKey,
            startedAt: baseTime - 62_000,
            status: "done",
          }),
          ...[
            {
              key: staleRunningChildKey,
              label: "Stale activity",
              status: "running",
              hasActiveRun: false,
            },
            { key: failedChildKey, label: "Failed checks", status: "failed", hasActiveRun: true },
          ].map(({ key, label, ...state }) =>
            sessionRow(key, label, baseTime - 4_000, {
              ...state,
              spawnedBy: parentKey,
              startedAt: baseTime - 64_000,
              ...(state.status === "failed"
                ? { endedAt: baseTime - 4_000, lastReadAt: baseTime }
                : {}),
              runtimeMs: state.status === "failed" ? 60_000 : 61_000,
              runtimeSampledAt: baseTime,
            }),
          ),
        ];
        const parentRow = sessionRow(parentKey, "Plan release", baseTime, {
          childSessions: [childOneKey, childTwoKey, staleRunningChildKey, failedChildKey],
        });
        await seedPersonalSessionPins(page, pinned ? [parentKey] : []);
        const gateway = await installMockGateway(page, {
          // Direct routes resolve canonical identity before the sidebar list arrives.
          sessions: [parentRow, ...children],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { spawnedBy: parentKey },
                  response: sessionsListResponse(children),
                },
                {
                  response: sessionsListResponse([parentRow]),
                },
              ],
            },
          },
          sessionKey: parentKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
        const parent = el(`[data-session-key="${parentKey}"]`);
        await parent.waitFor({ state: "visible", timeout: 10_000 });
        // Children that already exist at load stay collapsed; only new children reveal.
        const initialToggle = parent.locator("[data-child-session-toggle]");
        await initialToggle.waitFor();
        expect(await initialToggle.getAttribute("aria-expanded")).toBe("false");
        await expectCount(el(".sidebar-recent-session--child"), 0);
        // Delegated work keeps the idle parent's ring visible even with children collapsed.
        await expectCount(parent.locator(".sidebar-child-session-toggle--running"), 1);
        await parent.getByRole("img", { name: "Subagents working", exact: true }).waitFor();
        const accessibility = await context.newCDPSession(page);
        const collapsedTree = await accessibility.send("Accessibility.getFullAXTree");
        const collapsedToggle = collapsedTree.nodes.find(
          (node) =>
            node.role?.value === "button" &&
            node.name?.value === "Show 4 child sessions for Plan release",
        );
        expect(collapsedToggle?.description?.value).toBe("Active run");

        await parent
          .getByRole("button", { name: "Show 4 child sessions for Plan release" })
          .click();
        for (const label of [
          "Research sources",
          "Verify tests",
          "Stale activity",
          "Failed checks",
        ]) {
          await page.getByText(label, { exact: true }).waitFor({ state: "visible" });
        }
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).some(
              (request) => requireRecord(request.params).spawnedBy === parentKey,
            ),
          )
          .toBe(true);

        const childRows = el(".sidebar-recent-session--child");
        await expectCount(childRows, 4);
        expect(await childRows.locator("[data-sidebar-session-archive]").count()).toBe(4);
        const activeChild = el(`[data-session-key="${childOneKey}"]`);
        const completedChild = el(`[data-session-key="${childTwoKey}"]`);
        await activeChild.getByRole("img", { name: "Active run" }).waitFor();
        await completedChild.getByRole("img", { name: "Done" }).waitFor();
        await el(`[data-session-key="${failedChildKey}"]`)
          .getByRole("img", { name: "Failed" })
          .waitFor();
        for (const key of [staleRunningChildKey, failedChildKey]) {
          const child = el(`[data-session-key="${key}"]`);
          expect(await child.getByRole("img", { name: "Active run" }).count()).toBe(0);
          expect(await child.locator("openclaw-elapsed-time").count()).toBe(0);
          expect((await child.locator(".session-row-trail").textContent())?.trim()).toBeTruthy();
        }

        await expectCount(childRows.getByRole("img", { name: "Active run" }), 1);

        const childToggle = parent.locator(".sidebar-child-session-toggle--running");
        expect(await childToggle.count()).toBe(1);
        const expandedTree = await accessibility.send("Accessibility.getFullAXTree");
        const expandedToggle = expandedTree.nodes.find(
          (node) =>
            node.role?.value === "button" &&
            node.name?.value === "Hide 4 child sessions for Plan release",
        );
        expect(expandedToggle).toBeDefined();
        expect(expandedToggle?.description?.value ?? "").toBe("");
        await accessibility.detach();

        const tree = el(`[data-session-tree="${parentKey}"]`);
        // A personal pin moves the whole session tree, children included, into Pinned.
        expect(await tree.locator("xpath=ancestor::nav").count()).toBe(0);
        expect(await tree.count()).toBe(1);
        expect(
          await page
            .locator(`[data-session-section="pinned"] [data-session-tree="${parentKey}"]`)
            .count(),
        ).toBe(pinned ? 1 : 0);
        const nesting = await tree.evaluate((element) => {
          const parentElement = element.querySelector(".sidebar-recent-session")!;
          const childContainer = element.querySelector(".sidebar-session-tree__children")!;
          return {
            parentLeft: parentElement.getBoundingClientRect().left,
            childLeft: childContainer
              .querySelector(".sidebar-recent-session")!
              .getBoundingClientRect().left,
            guide: getComputedStyle(childContainer).backgroundImage,
          };
        });
        expect(nesting.childLeft - nesting.parentLeft).toBeGreaterThan(8);
        expect(nesting.guide).toBe("none");

        const childArchiveButton = completedChild.getByRole("button", {
          name: "Archive session: Verify tests",
          exact: true,
        });
        await completedChild.hover();
        await expect.poll(() => actionOpacity(childArchiveButton)).toBe("1");
        await expect.poll(() => actionPointerEvents(childArchiveButton)).toBe("auto");
        await completedChild.locator(".sidebar-recent-session__link").focus();
        await page.keyboard.press("Shift+F10");
        const childMenu = page.getByRole("menu", { name: "Actions for Verify tests" });
        await childMenu.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await childMenu.waitFor({ state: "detached" });

        await completedChild.getByRole("link").click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(childTwoKey));
      },
    );
  });

  it("dismisses fixed session menus before the sidebar or drawer hides", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(ordinarySessions()),
          "sessions.patch": {},
        },
        sessionKey: "agent:main:main",
      });
      // Control UI confirms in-app; a native dialog here would be a regression.
      const nativeDialogs: string[] = [];
      page.on("dialog", (dialog) => {
        nativeDialogs.push(dialog.message());
        void dialog.dismiss();
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = el("openclaw-app-sidebar");
      const row = sidebar.locator(
        '.sidebar-recent-session[data-session-key="agent:main:research"]',
      );
      const shell = el(".shell");
      const shellNav = el(".shell-nav");
      const sidebarToggle = el('[data-navigation-view="sessions"]');
      const drawerToggle = navigationDrawerToggle(page);
      const sessionMenu = page.getByRole("menu", { name: "Actions for Research notes" });
      await row.waitFor({ state: "visible", timeout: 10_000 });

      const openSessionMenu = async () => {
        // Keep dismissal setup independent of hover while the sidebar expands.
        await row.locator(".sidebar-recent-session__link").focus();
        await page.keyboard.press("Shift+F10");
        await page
          .getByRole("menu", { name: "Actions for Research notes" })
          .waitFor({ state: "visible" });
      };
      const expectDesktopCollapsed = async () => {
        await expectVisible(sidebar.locator(".sidebar-shell"), false);
        await expectVisible(sidebar.locator(".sidebar-rail"), true);
        await expectVisible(sidebarToggle, true);
        await expectFocused(sidebarToggle);
      };
      const expectDrawerClosed = async () => {
        await expect
          .poll(() => shell.getAttribute("class"))
          .not.toContain("shell--nav-drawer-open");
        await expect
          .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().right))
          .toBeLessThanOrEqual(0);
      };
      const hiddenActionCounts = async () => ({
        confirms: await el("openclaw-modal-dialog .exec-approval-actions").count(),
        nativeDialogs: nativeDialogs.length,
        patches: (await gateway.getRequests("sessions.patch")).length,
        personalPins: await sidebar
          .locator(
            '.sidebar-rail [data-sidebar-entry], [data-session-section="pinned"] .sidebar-recent-session',
          )
          .evaluateAll((entries) =>
            entries.map(
              (entry) =>
                entry.getAttribute("data-sidebar-entry") ?? entry.getAttribute("data-session-key"),
            ),
          ),
      });
      const expectHiddenShortcutsInert = async (
        before: Awaited<ReturnType<typeof hiddenActionCounts>>,
      ) => {
        for (const shortcut of ["p", "a", "d"] as const) {
          await page.keyboard.press(shortcut);
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await hiddenActionCounts()).toEqual(before);
      };

      // Keyboard collapse bypasses the menu's outside-pointer handler. The shell
      // must explicitly unmount it before the session panel becomes display:none.
      await openSessionMenu();
      const beforeKeyboardCollapse = await hiddenActionCounts();
      await page.keyboard.press("ControlOrMeta+B");
      await expectDesktopCollapsed();
      await expectCount(sessionMenu, 0);
      await expectHiddenShortcutsInert(beforeKeyboardCollapse);

      await sidebarToggle.click();
      await expectVisible(sidebar.locator(".sidebar-shell"), true);

      // The visible desktop control follows the same focus handoff contract.
      await openSessionMenu();
      await sidebarToggle.click();
      await expectDesktopCollapsed();
      await expectCount(sessionMenu, 0);
      await sidebarToggle.click();
      await expectVisible(sidebar.locator(".sidebar-shell"), true);

      // Crossing into drawer layout hides the desktop sidebar without toggling
      // persisted collapse state, so resize owns this dismissal and focus move.
      await openSessionMenu();
      const beforeNarrowTransition = await hiddenActionCounts();
      await page.setViewportSize({ height: 900, width: 900 });
      await expectDrawerClosed();
      await expectCount(sessionMenu, 0);
      await expectFocused(drawerToggle);
      await expectHiddenShortcutsInert(beforeNarrowTransition);

      await drawerToggle.click();
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      await expect
        .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().left))
        .toBe(0);

      // Leaving an open drawer must close its fixed menu and clear the drawer
      // before the same sidebar moves back into the desktop navigation slot.
      await openSessionMenu();
      const beforeWideTransition = await hiddenActionCounts();
      await page.setViewportSize({ height: 900, width: 1280 });
      await expect.poll(() => shell.getAttribute("class")).not.toContain("shell--mobile-nav");
      await expect.poll(() => shell.getAttribute("class")).not.toContain("shell--nav-drawer-open");
      await expectVisible(sidebar.locator(".sidebar-shell"), true);
      await expectCount(sessionMenu, 0);
      await expectHiddenShortcutsInert(beforeWideTransition);

      // Returning to drawer layout must not resurrect the prior open drawer.
      await page.setViewportSize({ height: 900, width: 900 });
      await expectDrawerClosed();
      await expectCount(sessionMenu, 0);
      await drawerToggle.click();
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      await expect
        .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().left))
        .toBe(0);
      await openSessionMenu();
      const beforeDrawerCollapse = await hiddenActionCounts();
      await page.keyboard.press("ControlOrMeta+B");
      await expectDrawerClosed();
      await expectCount(sessionMenu, 0);
      await expectFocused(drawerToggle);
      await expectHiddenShortcutsInert(beforeDrawerCollapse);
    });
  });

  it("names session-row actions and tabs from their context menu through the row controls", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            ...ordinarySessions(),
            sessionRow("agent:main:follow-up", "Follow-up work", baseTime - 7_200_000),
          ]),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const researchRow = page.locator('[data-session-key="agent:main:research"]');
      const followUpRow = page.locator('[data-session-key="agent:main:follow-up"]');
      const researchLink = researchRow.locator(".sidebar-recent-session__link");
      const researchArchive = researchRow.getByRole("button", {
        name: "Archive session: Research notes",
        exact: true,
      });
      await researchRow.getByRole("button", { name: "Pin session", exact: true }).waitFor();
      await followUpRow
        .getByRole("button", { name: "Archive session: Follow-up work", exact: true })
        .waitFor();
      expect(await researchRow.locator("[data-sidebar-session-menu]").isVisible()).toBe(false);

      await researchLink.focus();
      await page.keyboard.press("ContextMenu");
      const menu = page.getByRole("menu", { name: "Actions for Research notes" });
      await menu.waitFor({ state: "visible" });

      await expectFocused(
        page.locator("openclaw-session-menu").getByRole("menuitem", { name: "Pin session" }),
      );
      await page.keyboard.press("Tab");

      await expectCount(menu, 0);
      await expectFocused(researchRow.getByRole("button", { name: "Pin session", exact: true }));

      await page.keyboard.press("Tab");
      expect(await researchArchive.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
      await page.keyboard.press("Tab");
      expect(
        await followUpRow
          .locator(".sidebar-recent-session__link")
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
    });
  });

  it("retains sidebar sessions through transport loss and reloads them after client replacement", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const el = (selector: string) => page.locator(selector);

      const sessionKey = "agent:main:disconnect-proof";
      const otherSessionKeys = ["agent:main:other-a", "agent:main:other-b"] as const;
      await seedPersonalSessionPins(page, [sessionKey]);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, "Disconnect proof", Date.parse("2026-07-01T16:00:00.000Z")),
            sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z")),
            sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z")),
          ]),
        },
        sessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const sidebarRow = el(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const pinnedEntry = el(
        `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${sessionKey}"]`,
      );
      await sidebarRow.waitFor({ state: "visible", timeout: 10_000 });
      await expectCount(pinnedEntry, 1);
      const sidebarRows = el(".sidebar-recent-session");
      await expectCount(sidebarRows, 3);

      const socketsBefore = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expectText(sidebarRow, "Disconnect proof");
      await expectCount(sidebarRows, 3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }

      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBefore + 1);
      const reconnectSocketCount = await gateway.getSocketCount();
      await replaceGatewayClient(page);
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(reconnectSocketCount);
      await expectCount(pinnedEntry, 1);

      const refreshedResponse = sessionsListResponse([
        sessionRow(sessionKey, "Reconnect refreshed", Date.parse("2026-07-01T16:01:00.000Z")),
        sessionRow(otherSessionKeys[0], "Other A", Date.parse("2026-07-01T15:59:00.000Z")),
        sessionRow(otherSessionKeys[1], "Other B", Date.parse("2026-07-01T15:58:00.000Z")),
      ]);
      // Reconnect descriptors and roster reads must observe the same Gateway-owned rows.
      await gateway.setSessionsListResponse(refreshedResponse);
      await gateway.deferNext("sessions.list", rosterPreviewMatch);
      const reconnectPreviewCount = (await gateway.getRequests("sessions.list", rosterPreviewMatch))
        .length;
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterPreviewMatch)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(reconnectPreviewCount);
      await sidebarRow.waitFor({ state: "visible" });
      // A replacement client retires membership; only the fresh route descriptor is ready.
      expect(await sidebarRows.count()).toBe(1);
      for (const otherKey of otherSessionKeys) {
        expect(await el(`.sidebar-recent-session[data-session-key="${otherKey}"]`).count()).toBe(0);
      }

      const firstReconnectListCount = (await gateway.getRequests("sessions.list", rosterMatch))
        .length;
      await gateway.resolveDeferred("sessions.list");
      await expectText(sidebarRow, "Reconnect refreshed");
      await pinnedEntry.getByText("Reconnect refreshed", { exact: true }).waitFor();
      await expectCount(sidebarRows, 3);
      await expectRequestCountStable(
        gateway,
        "sessions.list",
        firstReconnectListCount,
        500,
        rosterMatch,
      );
    });
  });

  it("retains the selected session and one observer while reconnecting across route changes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const firstKey = "agent:main:reconnect-first";
      const selectedKey = "agent:main:reconnect-selected";
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(firstKey, "First session", Date.parse("2026-07-01T16:00:00.000Z")),
            sessionRow(selectedKey, "Selected session", Date.parse("2026-07-01T15:59:00.000Z")),
          ]),
        },
        sessionKey: firstKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
      const firstRow = page.locator(`.sidebar-recent-session[data-session-key="${firstKey}"]`);
      const selectedRow = page.locator(
        `.sidebar-recent-session[data-session-key="${selectedKey}"]`,
      );
      await firstRow.waitFor({ state: "visible", timeout: 10_000 });
      await selectedRow.waitFor({ state: "visible" });
      await gateway.waitForRequest("sessions.subscribe");

      await selectedRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      const initialObserverCount = (await gateway.getRequests("sessions.subscribe")).length;

      const socketsBefore = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBefore + 1);
      await gateway.setSessionsListResponse(
        sessionsListResponse([
          sessionRow(firstKey, "First session", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            selectedKey,
            "Selected session recovered",
            Date.parse("2026-07-01T16:01:00.000Z"),
          ),
        ]),
      );
      await gateway.deferNext("sessions.subscribe");
      await gateway.deferNext("sessions.list", rosterPreviewMatch);
      // Capture after disconnect so late requests from the old client cannot satisfy this wait.
      const reconnectPreviewCount = (await gateway.getRequests("sessions.list", rosterPreviewMatch))
        .length;
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.subscribe")).length, {
          timeout: 15_000,
        })
        .toBe(initialObserverCount + 1);

      await firstRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(firstKey));
      await selectedRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      expect(await gateway.getRequests("sessions.subscribe")).toHaveLength(
        initialObserverCount + 1,
      );

      await gateway.resolveDeferred("sessions.subscribe", { subscribed: true });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterPreviewMatch)).length)
        .toBeGreaterThan(reconnectPreviewCount);
      await gateway.resolveDeferred("sessions.list");
      await expectText(selectedRow, "Selected session recovered");
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      await expectCount(page.locator(".sidebar-recent-session--active"), 1);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      expect(await gateway.getRequests("sessions.subscribe")).toHaveLength(
        initialObserverCount + 1,
      );
    });
  });

  it("personally pins a session dropped on the Pinned section without changing its group", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();

    await seedPersonalSessionPins(page, ["agent:main:pinned"]);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:pinned", "Already pinned", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow("agent:main:candidate", "Pin me", Date.parse("2026-07-01T15:59:00.000Z"), {
            category: "Research",
          }),
        ]),
        "sessions.patch": {},
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
        "sessions.patch",
      ],
      sessionKey: "agent:main:candidate",
      sessionGroups: ["Research"],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:candidate"));

      const pinnedEntry = page.locator('[data-session-section="pinned"]');
      const researchGroup = page.locator('[data-session-section="category:Research"]');
      await pinnedEntry.getByText("Already pinned", { exact: true }).waitFor();
      const patchCount = (await gateway.getRequests("sessions.patch")).length;

      const pinnedBox = await pinnedEntry.boundingBox();
      if (!pinnedBox) {
        throw new Error("expected the pinned row to be laid out");
      }
      // The drop slot is decided by which half of the row the pointer is in, so
      // aim below its midpoint instead of the default centre landing on the edge.
      await researchGroup
        .locator('.sidebar-recent-session[data-session-key="agent:main:candidate"]')
        .dragTo(pinnedEntry, {
          targetPosition: { x: pinnedBox.width / 2, y: pinnedBox.height - 2 },
        });

      await expect
        .poll(() =>
          pinnedEntry
            .locator(".sidebar-recent-session__name")
            .evaluateAll((names) => names.map((name) => name.textContent?.trim())),
        )
        .toEqual(["Already pinned", "Pin me"]);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(patchCount);
      await expectCount(researchGroup.locator(".sidebar-recent-session"), 0);

      const pinnedCandidate = pinnedEntry.locator(
        '.sidebar-recent-session[data-session-key="agent:main:candidate"]',
      );
      await pinnedCandidate.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
      await pinnedCandidate.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unpin session" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Reset pinned items" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      const pin = pinnedCandidate.getByRole("button", { name: "Unpin session", exact: true });
      await pinnedCandidate.hover();
      const revealed = await sessionActionPresentation(pin);
      expect(revealed).toEqual({
        color: (
          await sessionActionPresentation(pinnedCandidate.locator("[data-sidebar-session-archive]"))
        ).color,
        fill: revealed.color,
      });
      await pin.hover();
      await expect
        .poll(async () => (await sessionActionPresentation(pin)).color)
        .not.toBe(revealed.color);
      await expect
        .poll(async () => {
          const hovered = await sessionActionPresentation(pin);
          return hovered.fill === hovered.color;
        })
        .toBe(true);
      await pin.click();
      await researchGroup.getByText("Pin me", { exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(patchCount);
    } finally {
      await context.close();
    }
  });

  it("keeps growing work rows readable and scrollable in a short sidebar", async () => {
    const nodeHash = "11c38726acc6fac280357576c87acc6fac280357";
    const rows = (withWork: boolean) => {
      const ts = baseTime + (withWork ? 5_000 : 0);
      return [
        sessionRow("agent:main:main", "Main", ts),
        sessionRow(
          "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d",
          "",
          ts - 60_000,
          withWork ? { execNode: nodeHash } : {},
        ),
        sessionRow(
          "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6e",
          "",
          ts - 120_000,
          withWork
            ? {
                execNode: nodeHash,
                worktree: { branch: "openclaw/wt-1", repoRoot: "/Users/dev/Projects/clawdbot" },
              }
            : {},
        ),
        sessionRow("agent:main:node-mcp-debug-4de003fbff138fcb9239c9378b2e", "", ts - 180_000),
        ...Array.from({ length: 30 }, (_, index) =>
          sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - (index + 10) * 60_000),
        ),
      ];
    };
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const el = (selector: string) => page.locator(selector);
      await page.setViewportSize({ height: 620, width: 1280 });
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(rows(false)),
        },
        sessionKey: "agent:main:main",
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => el(".sidebar-recent-session").count(), { timeout: 15_000 })
        .toBeGreaterThan(0);
      // Add work metadata only after first layout so the WebKit overlap
      // regression still exercises in-place row growth.
      const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.setSessionsListResponse(sessionsListResponse(rows(true)));
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "update",
        sessionKey: "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6e",
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBeGreaterThan(listRequests);
      const codingToggle = el('[data-session-section="work"] .sidebar-session-group-toggle');
      await codingToggle.waitFor({ state: "visible" });
      await expectAttribute(codingToggle, "aria-expanded", "false");
      await codingToggle.click();
      const namesLocator = el(".sidebar-recent-session__name");
      await expect
        .poll(() => trimmedTextContents(namesLocator))
        .toContain("clawdbot ⎇ wt-1 · …0357");

      const loadMore = el('[data-session-section="ungrouped"]').getByRole("button", {
        name: "Show more",
      });
      for (let pageIndex = 0; pageIndex < 3 && (await loadMore.isVisible()); pageIndex += 1) {
        const visibleRows = await el(".sidebar-recent-session").count();
        await loadMore.click();
        await expect.poll(() => el(".sidebar-recent-session").count()).toBeGreaterThan(visibleRows);
      }
      await el(".sidebar-shell__body").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() => el(".sidebar-recent-session").count(), { timeout: 15_000 })
        .toBe(rows(true).length);

      // Names and subtitles never show raw node ids or raw agent keys.
      const names = await trimmedTextContents(el(".sidebar-recent-session__name"));
      expect(names).toContain("New session");
      expect(names).toContain("clawdbot ⎇ wt-1 · …0357");
      expect(names).toContain("node-mcp-debug-…8b2e");
      const subtitles = await trimmedTextContents(el(".sidebar-recent-session__subtitle"));
      expect(subtitles).toContain("…0357");
      for (const text of [...names, ...subtitles]) {
        expect(text).not.toContain(nodeHash);
        expect(text).not.toContain("agent:main:");
      }

      // Sections must lay out below the rows above them, not paint over them.
      await expectNoOverlappingRows(page);
      const scroll = await page.evaluate(() => {
        const list = document.querySelector(".sidebar-shell__body");
        if (!list) {
          return null;
        }
        list.scrollTop = list.scrollHeight;
        return {
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          scrollTop: list.scrollTop,
        };
      });
      expect(scroll).not.toBeNull();
      expect(scroll?.scrollHeight ?? 0).toBeGreaterThan(scroll?.clientHeight ?? 0);
      expect(scroll?.scrollTop ?? 0).toBeGreaterThan(0);
    });
  });

  it("keeps sidebar session controls reachable on touch pointers", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "sessions.list": sessionsListResponse(ordinarySessions()),
          },
          sessionKey: "agent:main:main",
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const row = page
          .locator(".sidebar-recent-sessions__list .sidebar-recent-session")
          .filter({ hasText: "Research notes" });
        await row.waitFor({ state: "visible", timeout: 10_000 });
        const pin = row.getByRole("button", { name: "Pin session" });
        const archive = row.locator("[data-sidebar-session-archive]");
        await expect.poll(() => actionOpacity(pin)).toBe("1");
        await expect.poll(() => actionPointerEvents(pin)).toBe("auto");
        await expect.poll(() => actionOpacity(archive)).toBe("1");
        await expect.poll(() => actionPointerEvents(archive)).toBe("auto");
        await row.locator("[data-sidebar-session-menu]").tap();
        await page.getByRole("menuitem", { name: "Archive session" }).waitFor({ state: "visible" });
      },
    );
  });
});
