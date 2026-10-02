import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

/** Hold the actual navigation recipient and its shadow slot independently. */
async function holdSidebarDrawerToggleCommits(page: Page) {
  return page.evaluateHandle(() => {
    type UpdateOwner = HTMLElement & {
      readonly updateComplete: Promise<unknown>;
      scheduleUpdate: (this: UpdateOwner, ...args: unknown[]) => unknown;
    };
    const pane = document.querySelector<UpdateOwner>(
      "openclaw-chat-pane.chat-pane-cache__pane--visible.chat-pane-cache__pane--active",
    );
    const tooltipClass = customElements.get("openclaw-tooltip");
    if (!pane || !tooltipClass) {
      throw new Error("Expected the mounted chat pane and tooltip owner");
    }
    const tooltipPrototype = tooltipClass.prototype as UpdateOwner;
    const paneDescriptor = Object.getOwnPropertyDescriptor(pane, "scheduleUpdate");
    const tooltipDescriptor = Object.getOwnPropertyDescriptor(tooltipPrototype, "scheduleUpdate");
    const schedulePane = pane.scheduleUpdate;
    const scheduleTooltip = tooltipPrototype.scheduleUpdate;
    const paneGate = Promise.withResolvers<void>();
    const tooltipGate = Promise.withResolvers<void>();
    const held = {
      pane,
      tooltip: null as UpdateOwner | null,
      paneEntered: false,
      tooltipEntered: false,
      releasePane: () => paneGate.resolve(),
      releaseTooltip: () => tooltipGate.resolve(),
      dispose() {
        if (paneDescriptor) {
          Object.defineProperty(pane, "scheduleUpdate", paneDescriptor);
        } else {
          Reflect.deleteProperty(pane, "scheduleUpdate");
        }
        if (tooltipDescriptor) {
          Object.defineProperty(tooltipPrototype, "scheduleUpdate", tooltipDescriptor);
        } else {
          Reflect.deleteProperty(tooltipPrototype, "scheduleUpdate");
        }
        paneGate.resolve();
        tooltipGate.resolve();
      },
    };
    Object.defineProperty(pane, "scheduleUpdate", {
      configurable: true,
      writable: true,
      value(this: UpdateOwner, ...args: unknown[]) {
        held.paneEntered = true;
        return paneGate.promise.then(() => Reflect.apply(schedulePane, this, args));
      },
    });
    Object.defineProperty(tooltipPrototype, "scheduleUpdate", {
      configurable: true,
      writable: true,
      value(this: UpdateOwner, ...args: unknown[]) {
        if (!this.querySelector(".chat-pane__nav-toggle")) {
          return Reflect.apply(scheduleTooltip, this, args);
        }
        held.tooltip = this;
        held.tooltipEntered = true;
        return tooltipGate.promise.then(() => Reflect.apply(scheduleTooltip, this, args));
      },
    });
    return held;
  });
}

async function finishShellBreakpointFrame(page: Page) {
  await page.evaluate(async () => {
    const owner = document.querySelector("openclaw-app-shell") as HTMLElement & {
      readonly updateComplete: Promise<unknown>;
    };
    await owner.updateComplete;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

suite.define(() => {
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
      const collapseButton = page.locator(".sidebar-brand__collapse");
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
        await expect.poll(() => sidebar.isVisible()).toBe(false);
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
      // must explicitly unmount it before the sidebar becomes display:none.
      await openSessionMenu();
      const beforeKeyboardCollapse = await hiddenActionCounts();
      await page.keyboard.press("ControlOrMeta+B");
      await expectDesktopCollapsed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expectHiddenShortcutsInert(beforeKeyboardCollapse);

      await expandButton.click();
      await expect.poll(() => sidebar.isVisible()).toBe(true);

      // The visible desktop control follows the same focus handoff contract.
      await openSessionMenu();
      await collapseButton.click();
      await expectDesktopCollapsed();
      await expect.poll(() => sessionMenu.count()).toBe(0);
      await expandButton.click();
      await expect.poll(() => sidebar.isVisible()).toBe(true);

      // Crossing into drawer layout hides the desktop sidebar without toggling
      // persisted collapse state, so resize owns this dismissal and focus move.
      await openSessionMenu();
      const beforeNarrowTransition = await hiddenActionCounts();
      const navigationCommits = await holdSidebarDrawerToggleCommits(page);
      try {
        await page.setViewportSize({ height: 900, width: 900 });
        await page.waitForFunction((held) => held.paneEntered, navigationCommits);
        // The first resize already dismissed the menu; another mobile width still owes focus.
        await page.setViewportSize({ height: 900, width: 880 });
        // Advance the shell's existing focus frame while its actual recipient is held.
        await finishShellBreakpointFrame(page);
        await navigationCommits.evaluate((held) => held.releasePane());
        await page.waitForFunction((held) => held.tooltipEntered, navigationCommits);
        await navigationCommits.evaluate(async (held) => {
          await held.pane.updateComplete;
        });
        expect(
          await page
            .locator(".chat-pane__nav-toggle")
            .evaluate((element) => element.checkVisibility()),
        ).toBe(false);
        await navigationCommits.evaluate(async (held) => {
          held.releaseTooltip();
          await held.tooltip!.updateComplete;
        });
      } finally {
        await navigationCommits.evaluate(async (held) => {
          held.dispose();
          await Promise.allSettled([held.pane.updateComplete, held.tooltip?.updateComplete]);
        });
        await navigationCommits.dispose();
      }
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
      await expect.poll(() => sidebar.isVisible()).toBe(true);
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

  it("preserves newer focus while a responsive navigation handoff is pending", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: "agent:main:main",
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
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('.sidebar-recent-session[data-session-key="agent:main:research"]');
      await row.waitFor({ state: "visible" });
      for (const newerIntent of ["outside-focus", "wide-layout"] as const) {
        await page.setViewportSize({ height: 900, width: 1280 });
        await page.locator(".chat-pane__nav-toggle").waitFor({ state: "detached" });
        await row.locator(".sidebar-recent-session__link").focus();
        await page.keyboard.press("Shift+F10");
        await page.getByRole("menu", { name: "Actions for Research notes" }).waitFor();
        const held = await holdSidebarDrawerToggleCommits(page);
        const newerFocus =
          newerIntent === "outside-focus"
            ? page.locator(".agent-chat__composer-combobox textarea").first()
            : page.locator(".sidebar-brand__collapse");
        try {
          await page.setViewportSize({ height: 900, width: 900 });
          await page.waitForFunction((commits) => commits.paneEntered, held);
          await finishShellBreakpointFrame(page);
          if (newerIntent === "wide-layout") {
            await page.setViewportSize({ height: 900, width: 1280 });
            await newerFocus.waitFor({ state: "visible" });
          }
          await newerFocus.focus();
        } finally {
          await held.evaluate(async (commits) => {
            commits.dispose();
            await commits.pane.updateComplete;
            const tooltip = commits.pane
              .querySelector(".chat-pane__nav-toggle")
              ?.closest<HTMLElement & { readonly updateComplete: Promise<unknown> }>(
                "openclaw-tooltip",
              );
            await tooltip?.updateComplete;
          });
          await held.dispose();
        }
        expect(await newerFocus.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
      }
    });
  });
});
