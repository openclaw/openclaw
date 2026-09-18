import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { openSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();

function largeOwnerList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "human" as const,
    id: index === count - 1 ? `profile-${"owner-without-label-".repeat(10)}` : `profile-${index}`,
    ...(index === count - 1 ? {} : { label: `Owner ${index + 1}` }),
  }));
}

suite.define(() => {
  it("navigates linear filters and display controls with Tab, arrows, Space, and Escape", async () => {
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
      await expectBrowser(menu.getByRole("dialog")).toBeVisible();
      const active = menu.getByRole("radio", { name: "Active", exact: true });
      await expectBrowser(active).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expectBrowser(menu.getByRole("radio", { name: "Archived", exact: true })).toBeChecked();
      await page.keyboard.press("ArrowLeft");
      await expectBrowser(active).toBeChecked();
      await page.keyboard.press("Tab");
      const owners = menu.locator("#sidebar-sessions-owner");
      await expectBrowser(owners).toBeFocused();
      await expectBrowser(owners.locator('option[value^="owner:"]')).toHaveCount(5);
      await owners.selectOption("owner:profile-ada");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) =>
              (request.params as { ownerId?: unknown } | undefined)?.ownerId === "profile-ada",
          ),
        )
        .toBe(true);
      await expectBrowser(owners).toHaveValue("owner:profile-ada");
      await owners.focus();
      await page.keyboard.press("Tab");
      const automation = menu.getByRole("checkbox", { name: "Automation", exact: true });
      await expectBrowser(automation).toBeFocused();
      await page.keyboard.press("Space");
      await expectBrowser(automation).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Tab");
      const system = menu.getByRole("checkbox", { name: "System", exact: true });
      await expectBrowser(system).toBeFocused();
      await page.keyboard.press("Space");
      await expectBrowser(system).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu.getByRole("radio", { name: "Custom groups", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expectBrowser(menu.getByRole("radio", { name: "Project", exact: true })).toBeChecked();
      await page.keyboard.press("Tab");
      await expectBrowser(menu.locator("#sidebar-sessions-sort input:checked")).toBeFocused();
      await page.keyboard.press("Tab");
      const preview = menu.getByRole("checkbox", { name: "Show message preview", exact: true });
      await expectBrowser(preview).toBeFocused();
      await page.keyboard.press("Space");
      await expectBrowser(preview).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Tab");
      await expectBrowser(
        menu.getByRole("radio", { name: "When filtering", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      await expectBrowser(active).toBeFocused();
      await expectBrowser(owners).toHaveValue("owner:profile-ada");
      await menu.getByRole("link", { name: "Session sources…", exact: true }).focus();
      await page.keyboard.press("Tab");
      const reset = menu.getByRole("button", { name: "Reset", exact: true });
      await expectBrowser(reset).toBeFocused();
      await page.keyboard.press("Tab");
      await expectBrowser(menu).toHaveCount(0);
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
        await openSidebarMenu(page);
        const menu = page.locator(".sidebar-session-sort-menu");
        const menuBounds = await menu.locator(".sidebar-session-filter-panel").boundingBox();
        expect(menuBounds).not.toBeNull();
        expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
        expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
        expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(viewport.height);
        const owners = menu.locator("#sidebar-sessions-owner");
        await expectBrowser(owners.locator('option[value^="owner:"]')).toHaveCount(ownerCount);
        await owners.selectOption(`owner:${ownerOptions.at(-1)!.id}`);
        await expectBrowser(menu.getByRole("dialog")).toBeVisible();
        await expectBrowser(owners).toHaveValue(`owner:${ownerOptions.at(-1)!.id}`);
        const selectedBounds = await owners.boundingBox();
        expect(selectedBounds).not.toBeNull();
        expect(selectedBounds!.x + selectedBounds!.width).toBeLessThanOrEqual(viewport.width);
      } finally {
        await context.close();
      }
    },
  );

  it("keeps native owner selection and radio navigation usable in RTL", async () => {
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
      await openSidebarMenu(page);
      const menu = page.locator(".sidebar-session-sort-menu");
      const owners = menu.locator("#sidebar-sessions-owner");
      await owners.selectOption("owner:profile-0");
      await expectBrowser(owners).toHaveValue("owner:profile-0");
      const active = menu.getByRole("radio", { name: "Active", exact: true });
      await active.focus();
      await page.keyboard.press("ArrowLeft");
      await expectBrowser(menu.getByRole("radio", { name: "Archived", exact: true })).toBeChecked();
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(
        page.getByRole("button", { name: "Filter & sort", exact: true }),
      ).toBeFocused();
    } finally {
      await context.close();
    }
  });
});
