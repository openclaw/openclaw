import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

function largeOwnerList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "human" as const,
    id: index === count - 1 ? `profile-${"owner-without-label-".repeat(10)}` : `profile-${index}`,
    ...(index === count - 1 ? {} : { label: `Owner ${index + 1}` }),
  }));
}

suite.define(() => {
  it("navigates filter controls and the owner picker with Tab, arrows, Enter, and Escape", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": {
          ...sessionsListResponse([
            sessionRow("agent:main:ada", "Ada research", 2),
            sessionRow("agent:main:bob", "Bob operations", 1),
          ]),
          owners: [
            { type: "human", id: "profile-ada", label: "Ada Lovelace Byron" },
            { type: "human", id: "profile-bob", label: "Bob" },
            { type: "human", id: "profile-carol", label: "Carol" },
            { type: "human", id: "profile-dave", label: "Dave" },
          ],
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      const trigger = page.getByRole("button", { name: "Filter & sort" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.locator(".sidebar-session-sort-menu");
      const grouping = menu.getByRole("group", { name: "Group by", exact: true });
      await expectBrowser(
        grouping.getByRole("button", { name: "Custom groups", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowRight");
      const project = grouping.getByRole("button", { name: "Project", exact: true });
      await expectBrowser(project).toBeFocused();
      await expectBrowser(project).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("ArrowLeft");
      await expectBrowser(
        grouping.getByRole("button", { name: "Custom groups", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");

      await page.keyboard.press("Tab");
      const sort = menu.getByRole("group", { name: "Sort by", exact: true });
      await expectBrowser(sort.getByRole("button", { pressed: true })).toBeFocused();
      await page.keyboard.press("End");
      await expectBrowser(
        sort.getByRole("button", { name: "Owners", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Home");
      await expectBrowser(
        sort.getByRole("button", { name: "Created", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu
          .getByRole("group", { name: "Status", exact: true })
          .getByRole("button", { pressed: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      const owners = menu.getByRole("button", { name: /^Owners:/ });
      await expectBrowser(owners).toBeFocused();
      await page.keyboard.press("Enter");
      await expectBrowser(menu.getByRole("listbox", { name: "Owners", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expectBrowser(owners).toBeFocused();
      await expectBrowser(menu).toBeVisible();
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu.getByRole("switch", { name: "Show message preview", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu.getByRole("switch", { name: "Show automation sessions", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu.getByRole("switch", { name: "Show system sessions", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expectBrowser(menu.getByRole("button", { name: /^Hide empty groups:/ })).toBeFocused();
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu.getByRole("link", { name: "Session sources…", exact: true }),
      ).toBeFocused();

      await owners.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      const picker = menu.locator(".sidebar-session-owner-picker");
      await expectBrowser(picker.getByRole("menuitemradio")).toHaveCount(5);
      await page.keyboard.press("Escape");
      await expectBrowser(picker).toHaveCount(0);
      await expectBrowser(owners).toBeFocused();
      await expectBrowser(menu).toBeVisible();
      await page.keyboard.press("Enter");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expectBrowser(
        picker.getByRole("menuitem", { name: "Back", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expectBrowser(picker).toHaveCount(0);
      await expectBrowser(
        menu.getByRole("switch", { name: "Show message preview", exact: true }),
      ).toBeFocused();
      await expectBrowser(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(trigger).toBeFocused();

      await page.keyboard.press("Enter");
      await owners.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expectBrowser(
        picker.getByRole("menuitem", { name: "Back", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expectBrowser(
        picker.getByRole("menuitemradio", { name: "Patrick (You)", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expectBrowser(
        picker.getByRole("menuitemradio", { name: "Ada Lovelace Byron", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) =>
              (request.params as { ownerId?: unknown } | undefined)?.ownerId === "profile-ada",
          ),
        )
        .toBe(true);
      await expectBrowser(picker).toHaveCount(0);
      await expectBrowser(menu).toBeVisible();
      await expectBrowser(owners).toContainText("Ada Lovelace Byron");
      await owners.click();
      await menu.getByRole("option", { name: /^Specific owner/ }).click();
      await expectBrowser(
        picker.getByRole("menuitemradio", { name: "Ada Lovelace Byron", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
    } finally {
      await context.close();
    }
  });

  it.each([
    { name: "desktop", ownerCount: 60, viewport: { height: 800, width: 1200 } },
    { name: "compact", ownerCount: 30, viewport: { height: 650, width: 390 } },
  ])(
    "contains the filters and a large owner roster in the $name viewport",
    async ({ name, ownerCount, viewport }) => {
      const context = await suite.browser.newContext({ viewport });
      const page = await context.newPage();
      const ownerOptions = largeOwnerList(ownerCount);
      await installMockGateway(page, {
        sessionKey: "agent:main:large-roster",
        methodResponses: {
          "sessions.list": {
            ...sessionsListResponse([
              sessionRow("agent:main:large-roster", "Large owner roster", Date.now()),
            ]),
            owners: ownerOptions,
          },
        },
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:large-roster"));
        if (name === "compact") {
          await page.getByRole("button", { name: "Expand sidebar" }).click();
        }
        await page.getByRole("button", { name: "Filter & sort" }).click();
        const menu = page.locator(".sidebar-session-sort-menu");
        const menuBounds = await menu.locator(".sidebar-session-filter-panel").boundingBox();
        expect(menuBounds).not.toBeNull();
        expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
        expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
        expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(viewport.height);
        const owners = menu.getByRole("button", { name: /^Owners:/ });
        await owners.click();
        await menu.getByRole("option", { name: /^Specific owner/ }).click();
        const picker = menu.locator(".sidebar-session-owner-picker");
        const back = picker.getByRole("menuitem", { name: "Back", exact: true });
        await expectBrowser(back).toBeVisible();
        const metrics = await picker.locator('[part="menu"]').evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          };
        });
        expect(metrics.top).toBeGreaterThanOrEqual(0);
        expect(metrics.bottom).toBeLessThanOrEqual(viewport.height);
        expect(metrics.left).toBeGreaterThanOrEqual(0);
        expect(metrics.right).toBeLessThanOrEqual(viewport.width);
        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
        await back.click();
        await expectBrowser(picker).toHaveCount(0);
        await expectBrowser(owners).toBeFocused();
        await owners.click();
        await menu.getByRole("option", { name: /^Specific owner/ }).click();
        const lastOwner = picker.getByRole("menuitemradio").last();
        await lastOwner.click();
        await expectBrowser(picker).toHaveCount(0);
        await expectBrowser(menu).toBeVisible();
        await expectBrowser(owners).toContainText(ownerOptions.at(-1)!.id);
        const selectedBounds = await owners.boundingBox();
        expect(selectedBounds).not.toBeNull();
        expect(selectedBounds!.x + selectedBounds!.width).toBeLessThanOrEqual(viewport.width);
      } finally {
        await context.close();
      }
    },
  );

  it("mirrors the owner picker's Back arrow in RTL", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 650, width: 390 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey: "agent:main:rtl-owners",
      methodResponses: {
        "sessions.list": {
          ...sessionsListResponse([sessionRow("agent:main:rtl-owners", "RTL owners", Date.now())]),
          owners: largeOwnerList(3),
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:rtl-owners"));
      await page.locator("html").evaluate((element) => element.setAttribute("dir", "rtl"));
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.getByRole("button", { name: "Filter & sort" }).click();
      await page.getByRole("button", { name: /^Owners:/ }).click();
      await page.getByRole("option", { name: /^Specific owner/ }).click();
      await expect
        .poll(() =>
          page
            .getByRole("menuitem", { name: "Back", exact: true })
            .locator(":scope > .session-menu__icon")
            .evaluate((element) => getComputedStyle(element).transform),
        )
        .toContain("-1");
    } finally {
      await context.close();
    }
  });
});
