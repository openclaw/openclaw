import type { Locator, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { assert, expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarOwner,
  openSidebarMenu,
  settleSidebarMenuMotion,
} from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();

function largeOwnerList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "human" as const,
    id: index === count - 1 ? `profile-${"owner-without-label-".repeat(10)}` : `profile-${index}`,
    ...(index === count - 1 ? {} : { label: `Owner ${index + 1}` }),
  }));
}

async function openRoster(
  page: Page,
  sessions: ReturnType<typeof sessionRow>[],
  owners: ReturnType<typeof largeOwnerList>,
  options: Pick<
    NonNullable<Parameters<typeof installMockGateway>[1]>,
    "presenceUsers" | "historyMessages"
  > = {},
) {
  const [first] = sessions;
  assert(first, "Expected a session to open");
  const key = first.key;
  const gateway = await installMockGateway(page, {
    ...options,
    sessionKey: key,
    methodResponses: { "sessions.list": { ...sessionsListResponse(sessions), owners } },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  return gateway;
}

async function expectContained(locator: Locator, viewport: { width: number; height: number }) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
}

suite.define(() => {
  it("navigates session filters and display controls with Tab, arrows, Space, and Escape", () =>
    suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
      const gateway = await openRoster(
        page,
        [
          sessionRow("agent:main:ada", "Ada research", 2),
          sessionRow("agent:main:bob", "Bob operations", 1),
        ],
        [
          { type: "human", id: "profile-ada", label: "Ada Lovelace Byron" },
          { type: "human", id: "profile-bob", label: "Bob" },
          { type: "human", id: "profile-carol", label: "Carol" },
          { type: "human", id: "profile-dave", label: "Dave" },
        ],
        {
          presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
          historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        },
      );
      await waitForSessionRosterHydration(page);
      await selectAllSidebarSessions(page);
      const trigger = page.getByRole("button", { name: /^Filter & sort · /, exact: true });
      const owners = page.locator("#sidebar-session-owner-title");
      const picker = page.locator(".sidebar-session-owner-filter");
      await owners.focus();
      await page.keyboard.press("Enter");
      await expectBrowser(picker.locator('[role="option"][data-value^="owner:"]')).toHaveCount(5);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("sessions.list", { ownerId: "profile-ada" })).length > 0,
        )
        .toBe(true);
      await expectBrowser(owners).toHaveAccessibleName("Owners: Ada Lovelace Byron");
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.locator(".sidebar-session-sort-menu");
      const active = menu.getByRole("radio", { name: "Active", exact: true });
      await expectBrowser(active).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expectBrowser(menu.getByRole("radio", { name: "Snoozed", exact: true })).toBeChecked();
      await page.keyboard.press("ArrowLeft");
      await expectBrowser(active).toBeChecked();
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      await expectBrowser(active).toBeFocused();
      await expectBrowser(menu.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
      await expectBrowser(owners).toHaveAccessibleName("Owners: Ada Lovelace Byron");
      await menu.getByRole("link", { name: "Session sources", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expectBrowser(menu).toHaveCount(0);
    }));

  it.each([
    { name: "desktop", ownerCount: 60, viewport: { height: 800, width: 1200 } },
    { name: "compact", ownerCount: 30, viewport: { height: 650, width: 390 } },
  ])(
    "contains the filters and a large owner roster in the $name viewport",
    ({ name, ownerCount, viewport }) =>
      suite.withPage({ viewport }, async ({ page }) => {
        const ownerOptions = largeOwnerList(ownerCount);
        await openRoster(
          page,
          [sessionRow("agent:main:large-roster", "Large owner roster", Date.now())],
          ownerOptions,
        );
        if (name === "compact") {
          await page.getByRole("button", { name: "Expand sidebar" }).click();
        }
        await page.getByRole("button", { name: /^Filter & sort · /, exact: true }).click();
        await openSidebarMenu(page);
        const menu = page.locator(".sidebar-session-sort-menu");
        await expectContained(menu.locator(".sidebar-session-filter-panel"), viewport);
        await page.keyboard.press("Escape");
        const owners = page.locator("#sidebar-session-owner-title");
        await owners.click();
        await expectBrowser(
          page.locator('.sidebar-session-owner-filter [role="option"][data-value^="owner:"]'),
        ).toHaveCount(ownerCount);
        const list = page.getByRole("listbox", { name: "Owners", exact: true });
        await settleSidebarMenuMotion(list);
        await expectContained(list, viewport);
        await page.locator(".sidebar-session-owner-filter .header-search__toggle").click();
        await page
          .getByRole("combobox", { name: "Search", exact: true })
          .fill(ownerOptions.at(-1)!.id);
        await expectBrowser(list.getByRole("option")).toHaveCount(1);
        await list.getByRole("option").click();
        await expectBrowser(menu).toHaveCount(0);
        await expectBrowser(owners).toHaveAccessibleName(`Owners: ${ownerOptions.at(-1)!.id}`);
        const selectedBounds = await owners.boundingBox();
        expect(selectedBounds).not.toBeNull();
        expect(selectedBounds!.x + selectedBounds!.width).toBeLessThanOrEqual(viewport.width);
      }),
  );

  it("keeps owner selection and radio navigation usable in RTL", () =>
    suite.withPage({ viewport: { height: 650, width: 390 } }, async ({ page }) => {
      await openRoster(
        page,
        [sessionRow("agent:main:rtl-owners", "RTL owners", Date.now())],
        largeOwnerList(3),
      );
      await page.locator("html").evaluate((element) => element.setAttribute("dir", "rtl"));
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.getByRole("button", { name: /^Filter & sort · /, exact: true }).click();
      await openSidebarMenu(page);
      const menu = page.locator(".sidebar-session-sort-menu");
      const owners = page.locator("#sidebar-session-owner-title");
      await page.keyboard.press("Escape");
      await chooseSidebarOwner(page, "owner:profile-0");
      await expectBrowser(owners).toHaveAccessibleName("Owners: Owner 1");
      await openSidebarMenu(page);
      const active = menu.getByRole("radio", { name: "Active", exact: true });
      const snoozed = menu.getByRole("radio", { name: "Snoozed", exact: true });
      await active.focus();
      await page.keyboard.press("ArrowLeft");
      await expectBrowser(snoozed).toBeChecked();
      await expectBrowser(snoozed).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expectBrowser(active).toBeChecked();
      await expectBrowser(active).toBeFocused();
      await page.keyboard.press("Escape");
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(
        page.getByRole("button", { name: /^Filter & sort · /, exact: true }),
      ).toBeFocused();
    }));
});
