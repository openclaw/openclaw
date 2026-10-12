import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  actionOpacity,
  actionPointerEvents,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
  trimmedTextContents,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const rosterMatch = { includeGlobal: true };
const rosterPreviewMatch = { ...rosterMatch, includeLastMessage: true };

async function seedPersonalSessionPins(page: Page, keys: string[]) {
  await page.addInitScript(
    ({ storageKey, entries }) => {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      if (!Array.isArray(stored.sidebarEntries)) {
        localStorage.setItem(storageKey, JSON.stringify({ ...stored, sidebarEntries: entries }));
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

suite.define(() => {
  it.each([false, true])("nests spawned sessions (personal pin: %s)", async (pinned) => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const parentKey = "agent:main:release-plan";
    const childOneKey = "agent:main:research-sources";
    const childTwoKey = "agent:main:verify-tests";
    const staleRunningChildKey = "agent:main:stale-running";
    const failedChildKey = "agent:main:failed-checks";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
      {
        ...sessionRow(staleRunningChildKey, "Stale activity", baseTime - 3_000, {
          hasActiveRun: false,
          spawnedBy: parentKey,
          startedAt: baseTime - 64_000,
          status: "running",
        }),
        runtimeMs: 61_000,
        runtimeSampledAt: baseTime,
      },
      {
        ...sessionRow(failedChildKey, "Failed checks", baseTime - 4_000, {
          endedAt: baseTime - 4_000,
          hasActiveRun: true,
          spawnedBy: parentKey,
          startedAt: baseTime - 64_000,
          status: "failed",
        }),
        lastReadAt: baseTime,
        runtimeMs: 60_000,
        runtimeSampledAt: baseTime,
      },
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

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const parent = page.locator(`[data-session-key="${parentKey}"]`);
      await parent.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => page.locator(".sidebar-recent-session--child").count()).toBe(0);
      // Delegated work keeps the idle parent's ring visible even with children collapsed.
      await expect
        .poll(() => parent.locator(".sidebar-child-session-toggle--running").count())
        .toBe(1);
      await parent.getByRole("img", { name: "Subagents working", exact: true }).waitFor();
      const accessibility = await context.newCDPSession(page);
      const collapsedTree = await accessibility.send("Accessibility.getFullAXTree");
      const collapsedToggle = collapsedTree.nodes.find(
        (node) =>
          node.role?.value === "button" &&
          node.name?.value === "Show 4 child sessions for Plan release",
      );
      expect(collapsedToggle?.description?.value).toBe("Active run");
      await captureUiProof(suite, page, "child-sessions-collapsed.png");

      await parent.getByRole("button", { name: "Show 4 child sessions for Plan release" }).click();
      for (const label of ["Research sources", "Verify tests", "Stale activity", "Failed checks"]) {
        await page.getByText(label, { exact: true }).waitFor({ state: "visible" });
      }
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) => requireRecord(request.params).spawnedBy === parentKey,
          ),
        )
        .toBe(true);

      const childRows = page.locator(".sidebar-recent-session--child");
      await expect.poll(() => childRows.count()).toBe(4);
      expect(await childRows.locator("[data-sidebar-session-archive]").count()).toBe(4);
      await childRows.nth(0).getByRole("img", { name: "Active run" }).waitFor();
      await childRows.nth(1).getByRole("img", { name: "Done" }).waitFor();

      const staleRunningChild = page.locator(`[data-session-key="${staleRunningChildKey}"]`);
      const failedChild = page.locator(`[data-session-key="${failedChildKey}"]`);
      await failedChild.getByRole("img", { name: "Failed" }).waitFor();
      await expect.poll(() => childRows.getByRole("img", { name: "Active run" }).count()).toBe(1);

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
      for (const child of [staleRunningChild, failedChild]) {
        expect(await child.getByRole("img", { name: "Active run" }).count()).toBe(0);
        expect(await child.locator("openclaw-elapsed-time").count()).toBe(0);
        expect((await child.locator(".session-row-trail").textContent())?.trim()).toBeTruthy();
      }
      await captureUiProof(suite, page, "child-sessions-expanded.png");
      await captureUiProof(suite, page, "child-sessions-run-state-precedence.png");

      const tree = page.locator(`[data-session-tree="${parentKey}"]`);
      // Personal pins are flat shortcuts; the ordinary session tree keeps its children.
      expect(await tree.locator("xpath=ancestor::nav").count()).toBe(0);
      const railPin = page.locator(`.sidebar-rail [data-sidebar-entry="session:${parentKey}"]`);
      expect(await railPin.count()).toBe(pinned ? 1 : 0);
      expect(await railPin.locator("[data-session-tree]").count()).toBe(0);
      if (pinned) {
        expect(await railPin.getByRole("link", { name: "Plan release", exact: true }).count()).toBe(
          1,
        );
      }
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

      const completedChild = childRows.nth(1);
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
      await page.getByRole("menuitem", { name: "Mark as unread" }).waitFor();
      await page.getByRole("menuitem", { name: "Rename…" }).waitFor();
      await page.getByRole("menuitem", { name: "Advanced", exact: true }).waitFor();
      await page.getByRole("menuitem", { name: "Archive session" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Pin session" }).count()).toBe(0);
      expect(await page.getByRole("menuitem", { name: "Move to group" }).isEnabled()).toBe(true);
      expect(await page.getByRole("menuitem", { name: "Move to top level" }).isEnabled()).toBe(
        true,
      );
      await captureUiProof(suite, page, "child-session-menu.png");
      await openSessionMenuSubmenu(page, "Advanced");
      await page.getByRole("menuitem", { name: "Fork conversation" }).waitFor();
      await page.getByRole("menuitem", { name: "Delete…" }).waitFor();
      await page.getByRole("menuitem", { name: "Icon & color", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await childMenu.waitFor({ state: "detached" });

      await childRows.nth(1).getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(childTwoKey));
    } finally {
      await context.close();
    }
  });

  it("dismisses fixed session menus before the sidebar or drawer hides", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
        ]),
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

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator(
        '.sidebar-recent-session[data-session-key="agent:main:research"]',
      );
      const shell = page.locator(".shell");
      const shellNav = page.locator(".shell-nav");
      const collapseButton = page.locator('[data-navigation-view][aria-pressed="true"]');
      const expandButton = page.locator(".shell-chrome-controls__nav-toggle");
      const drawerToggle = page
        .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
        .first();
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
        await expect.poll(() => sidebar.locator(".sidebar-shell").isVisible()).toBe(false);
        await expect.poll(() => sidebar.locator(".sidebar-rail").isVisible()).toBe(true);
        await expect.poll(() => expandButton.isVisible()).toBe(true);
        await expect
          .poll(() => expandButton.evaluate((element) => element === document.activeElement))
          .toBe(true);
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
        confirms: await page.locator("openclaw-modal-dialog .exec-approval-actions").count(),
        nativeDialogs: nativeDialogs.length,
        patches: (await gateway.getRequests("sessions.patch")).length,
        personalPins: await sidebar
          .locator(".sidebar-rail [data-sidebar-entry]")
          .evaluateAll((entries) =>
            entries.map((entry) => entry.getAttribute("data-sidebar-entry")),
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
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expectHiddenShortcutsInert(beforeKeyboardCollapse);

      await expandButton.click();
      await expect.poll(() => sidebar.locator(".sidebar-shell").isVisible()).toBe(true);

      // The visible desktop control follows the same focus handoff contract.
      await openSessionMenu();
      await collapseButton.click();
      await expectDesktopCollapsed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expandButton.click();
      await expect.poll(() => sidebar.locator(".sidebar-shell").isVisible()).toBe(true);

      // Crossing into drawer layout hides the desktop sidebar without toggling
      // persisted collapse state, so resize owns this dismissal and focus move.
      await openSessionMenu();
      const beforeNarrowTransition = await hiddenActionCounts();
      await page.setViewportSize({ height: 900, width: 900 });
      await expectDrawerClosed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expect
        .poll(() => drawerToggle.evaluate((element) => element === document.activeElement))
        .toBe(true);
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
      await expect.poll(() => sidebar.locator(".sidebar-shell").isVisible()).toBe(true);
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expectHiddenShortcutsInert(beforeWideTransition);

      // Returning to drawer layout must not resurrect the prior open drawer.
      await page.setViewportSize({ height: 900, width: 900 });
      await expectDrawerClosed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await drawerToggle.click();
      await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
      await expect
        .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().left))
        .toBe(0);
      await openSessionMenu();
      const beforeDrawerCollapse = await hiddenActionCounts();
      await page.keyboard.press("ControlOrMeta+B");
      await expectDrawerClosed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expect
        .poll(() => drawerToggle.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expectHiddenShortcutsInert(beforeDrawerCollapse);
    } finally {
      await context.close();
    }
  });

  it("names session-row actions and tabs from their context menu through the row controls", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
          sessionRow(
            "agent:main:follow-up",
            "Follow-up work",
            Date.parse("2026-07-01T14:00:00.000Z"),
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
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

      await expect
        .poll(() =>
          page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Pin session" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Tab");

      await expect.poll(() => menu.count()).toBe(0);
      await expect
        .poll(() =>
          researchRow
            .getByRole("button", { name: "Pin session", exact: true })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);

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

      await researchRow.locator(".sidebar-recent-session__link").focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          page
            .locator("openclaw-session-menu")
            .getByRole("menuitem", { name: "Pin session" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Tab");

      await expect.poll(() => menu.count()).toBe(0);
      await expect
        .poll(() =>
          researchRow
            .getByRole("button", { name: "Pin session", exact: true })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar sessions visible through transport and client replacement reconnects", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
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

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const pinnedEntry = page.locator(`[data-sidebar-entry="session:${sessionKey}"]`);
      await sidebarRow.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => pinnedEntry.count()).toBe(1);
      const sidebarRows = page.locator(".sidebar-recent-session");
      await expect.poll(() => sidebarRows.count()).toBe(3);

      const socketsBefore = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => sidebarRow.textContent()).toContain("Disconnect proof");
      await expect.poll(() => sidebarRows.count()).toBe(3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }
      await captureUiProof(suite, page, "sidebar-sessions-during-reconnect.png");

      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
        .toBe(socketsBefore + 1);
      await page.locator(".sidebar-identity-card").click();
      const retryConnection = page.locator(
        'wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:retry-connect"]',
      );
      await retryConnection.waitFor({ state: "visible", timeout: 10_000 });
      await retryConnection.click();
      await expect.poll(() => pinnedEntry.count()).toBe(1);
      await captureUiProof(suite, page, "sidebar-sessions-during-client-replacement.png");

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
      expect(await sidebarRows.count()).toBe(3);
      for (const otherKey of otherSessionKeys) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${otherKey}"]`)
          .waitFor({ state: "visible" });
      }

      const firstReconnectListCount = (await gateway.getRequests("sessions.list", rosterMatch))
        .length;
      await gateway.resolveDeferred("sessions.list");
      await expect.poll(() => sidebarRow.textContent()).toContain("Reconnect refreshed");
      await pinnedEntry.getByRole("link", { name: "Reconnect refreshed", exact: true }).waitFor();
      await expect.poll(() => sidebarRows.count()).toBe(3);
      await expectRequestCountStable(
        gateway,
        "sessions.list",
        firstReconnectListCount,
        500,
        rosterMatch,
      );
    } finally {
      await context.close();
    }
  });

  it("retains the selected session and one observer while reconnecting across route changes", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
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

    try {
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
      await expect.poll(() => selectedRow.textContent()).toContain("Selected session recovered");
      await expect.poll(() => selectedRow.getAttribute("class")).toContain("--active");
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedKey));
      expect(await gateway.getRequests("sessions.subscribe")).toHaveLength(
        initialObserverCount + 1,
      );
      await captureUiProof(suite, page, "sidebar-selected-session-route-reconnect.png");
    } finally {
      await context.close();
    }
  });

  it("keeps a personal pin alongside its ordinary chat and presents its pin state", async () => {
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
          sessionRow("agent:main:pinned", "Pinned only", Date.parse("2026-07-01T16:00:00.000Z")),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:pinned",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:pinned"));

      const pinnedEntry = page.locator('[data-sidebar-entry="session:agent:main:pinned"]');
      const chatsGroup = page.locator('[data-session-section="ungrouped"]');
      await pinnedEntry.getByRole("link", { name: "Pinned only", exact: true }).waitFor();
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await pinnedEntry.locator(".sidebar-recent-session").count()).toBe(0);
      const ordinaryRow = chatsGroup.locator('[data-session-key="agent:main:pinned"]');
      await expect.poll(() => page.locator(".sidebar-recent-session--active").count()).toBe(1);
      const pin = ordinaryRow.getByRole("button", { name: "Unpin session" });
      const menu = ordinaryRow.locator("[data-sidebar-session-archive]");
      await ordinaryRow.hover();
      await captureUiProof(suite, page, "pinned-session-icon.png");
      const revealedPin = await sessionActionPresentation(pin);
      const revealedMenu = await sessionActionPresentation(menu);
      expect(revealedPin.color).toBe(revealedMenu.color);
      expect(revealedPin.fill).toBe(revealedPin.color);

      await pin.hover();
      await expect
        .poll(async () => (await sessionActionPresentation(pin)).color)
        .not.toBe(revealedPin.color);
      await expect
        .poll(async () => {
          const hoveredPin = await sessionActionPresentation(pin);
          return hoveredPin.fill === hoveredPin.color;
        })
        .toBe(true);

      // Removing the rail shortcut by drag never moves or patches the shared row.
      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      await pinnedEntry.dragTo(page.locator(".sidebar-recent-sessions"));
      await expect.poll(() => pinnedEntry.count()).toBe(0);
      await expect.poll(() => chatsGroup.locator(".sidebar-recent-session").count()).toBe(1);
      await ordinaryRow.getByRole("button", { name: "Pin session", exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(patchCount);
    } finally {
      await context.close();
    }
  });

  it("personally pins a session dropped below an existing rail shortcut without moving its group", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
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

      const pinnedEntry = page.locator('[data-sidebar-entry="session:agent:main:pinned"]');
      const researchGroup = page.locator('[data-session-section="category:Research"]');
      await pinnedEntry.getByRole("link", { name: "Already pinned", exact: true }).waitFor();
      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      await captureUiProof(suite, page, "sidebar-session-before-pinned-drop.png");
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
          page
            .locator('.sidebar-rail [data-sidebar-entry^="session:"] a')
            .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label"))),
        )
        .toEqual(["Already pinned", "Pin me"]);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(patchCount);
      await expect.poll(() => researchGroup.locator(".sidebar-recent-session").count()).toBe(1);

      const pinnedCandidate = researchGroup.locator(
        '.sidebar-recent-session[data-session-key="agent:main:candidate"]',
      );
      await pinnedCandidate.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
      await pinnedCandidate.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Unpin session" }).waitFor();
      expect(await page.getByRole("menuitem", { name: "Reset pinned items" }).count()).toBe(0);
      await captureUiProof(
        suite,
        page,
        "sidebar-session-dropped-into-pinned.png",
        page.locator('openclaw-session-menu > wa-dropdown [part="menu"]'),
        [page.getByRole("menuitem", { name: "Unpin session" })],
      );
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "sidebar-session-pinned-drop.webm"));
      }
    }
  });

  it("keeps raw ids out of work rows while their metadata grows in place", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
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
      ];
    };
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows(false)),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator(".sidebar-recent-session").count(), { timeout: 15_000 })
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
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      await codingToggle.waitFor({ state: "visible" });
      await expect.poll(() => codingToggle.getAttribute("aria-expanded")).toBe("false");
      await codingToggle.click();
      const namesLocator = page.locator(".sidebar-recent-session__name");
      await expect
        .poll(() => trimmedTextContents(namesLocator))
        .toContain("clawdbot ⎇ wt-1 · …0357");

      // Names and subtitles never show raw node ids or raw agent keys.
      const names = await trimmedTextContents(page.locator(".sidebar-recent-session__name"));
      expect(names).toContain("New session");
      expect(names).toContain("clawdbot ⎇ wt-1 · …0357");
      expect(names).toContain("node-mcp-debug-…8b2e");
      const subtitles = await trimmedTextContents(
        page.locator(".sidebar-recent-session__subtitle"),
      );
      expect(subtitles).toContain("…0357");
      for (const text of [...names, ...subtitles]) {
        expect(text).not.toContain(nodeHash);
        expect(text).not.toContain("agent:main:");
      }

      // Sections must lay out below the rows above them, not paint over them.
      const overlaps = await page.evaluate(() => {
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
      });
      expect(overlaps).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("scrolls long session lists in short windows instead of squeezing sections", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        sessionRow(`agent:main:work-${index}`, `Work session ${index}`, baseTime - index * 60_000, {
          worktree: { branch: `openclaw/wt-${index}`, repoRoot: "/Users/dev/Projects/clawdbot" },
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - (index + 10) * 60_000),
      ),
    ];
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 620, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows),
      },
      sessionKey: "agent:main:main",
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator('[data-session-section="work"] .sidebar-session-group-toggle').click();
      const loadMore = page
        .locator('[data-session-section="ungrouped"]')
        .getByRole("button", { name: "Show more" });
      for (let pageIndex = 0; pageIndex < 3 && (await loadMore.isVisible()); pageIndex += 1) {
        await loadMore.click();
      }
      await page.locator(".sidebar-shell__body").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() => page.locator(".sidebar-recent-session").count(), { timeout: 15_000 })
        .toBe(rows.length);
      await captureUiProof(suite, page, "short-window-session-sections.png");

      // Sections must stack below each other, not paint over the rows above.
      const overlaps = await page.evaluate(() => {
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
      });
      expect(overlaps).toBe(0);

      // The squeeze regression compressed sections into the viewport with no
      // overflow; a healthy sidebar body is taller than its viewport and scrolls.
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
    } finally {
      await context.close();
    }
  });

  it("keeps sidebar session controls reachable on touch pointers", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(
            "agent:main:research",
            "Research notes",
            Date.parse("2026-07-01T15:00:00.000Z"),
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
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
    } finally {
      await context.close();
    }
  });
});
