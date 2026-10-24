import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    Object.assign(root.dataset, { themeMode: nextMode, themeResolved: nextMode });
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

suite.define(() =>
  it("moves a categorized group session back to Groups", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const key = "agent:main:done-group";
        const rows = [
          sessionRow("agent:main:main", "Main", 2),
          sessionRow(key, "Completed launch", 1, {
            category: "Done",
            kind: "group",
          }),
        ];
        const gateway = await ui.installSessionRows(page, rows, {
          methodResponses: { "sessions.patch": {} },
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.groups.list",
            "sessions.groups.put",
            "sessions.patch",
          ],
          sessionGroups: ["Done"],
          sessionKey: "agent:main:main",
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await chooseSidebarMenuOption(page, "Status", "All");
        await closeSidebarMenu(page);
        const done = page.locator('[data-session-section="category:Done"]');
        const groups = page.locator('[data-session-section="groups"]');
        const row = done.locator(`[data-session-key="${key}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
        await closeSidebarMenu(page);
        await groups.waitFor({ state: "visible" });

        await row.hover();
        await row.click({ button: "right" });
        await support.openSessionMenuSubmenu(page, "Move to group");
        await ui.menuItem(page, "Move back to Groups").waitFor({ state: "visible" });
        const capture = (name: string) =>
          support.captureUiProof(suite, page, `sidebar-done-return-${name}.png`);
        await setThemeMode(page, "light");
        await capture("before-light");
        await setThemeMode(page, "dark");
        await capture("before-dark");

        await setThemeMode(page, "light");
        await page.reload();
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await groups.waitFor({ state: "visible" });
        await expect.poll(() => row.getAttribute("draggable")).toBe("true");
        await row.dragTo(groups, {
          sourcePosition: { x: 8, y: 8 },
          targetPosition: { x: 8, y: 8 },
        });
        await ui.sessionPatch(gateway, key, { category: null });
        await ui.visible(groups.locator(`[data-session-key="${key}"]`));
        await capture("after-light");
        await setThemeMode(page, "dark");
        await capture("after-dark");
      },
      { colorScheme: "light" },
    )),
);
