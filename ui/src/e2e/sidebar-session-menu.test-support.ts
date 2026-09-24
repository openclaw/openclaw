import type { Page } from "playwright";

export async function openSidebarMenu(page: Page) {
  const menu = page.locator(".sidebar-session-sort-menu");
  const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await menu.getByRole("dialog").waitFor();
  return menu;
}

export async function chooseSidebarMenuOption(
  page: Page,
  label: "Group by" | "Sort by" | "Status" | "Owners" | "Hide empty groups",
  option: string,
) {
  const menu = await openSidebarMenu(page);
  if (label !== "Status") {
    await menu
      .locator(
        label === "Owners"
          ? "#sidebar-sessions-owner"
          : label === "Group by"
            ? "#sidebar-sessions-group"
            : label === "Sort by"
              ? "#sidebar-sessions-sort"
              : "#sidebar-sessions-empty",
      )
      .click();
    await menu.getByRole("option", { name: option, exact: true }).click();
    return;
  }
  await menu
    .locator(
      label === "Status"
        ? "#sidebar-sessions-status"
        : label === "Sort by"
          ? "#sidebar-sessions-sort"
          : "#sidebar-sessions-empty",
    )
    .getByRole("radio", { name: option, exact: true })
    .click();
}

export async function closeSidebarMenu(page: Page) {
  const menu = page.locator(".sidebar-session-sort-menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

export async function chooseSidebarOwner(page: Page, value: string) {
  const menu = await openSidebarMenu(page);
  await menu.locator("#sidebar-sessions-owner").click();
  await menu.locator(`[role="option"][data-value="${value}"]`).click();
}
