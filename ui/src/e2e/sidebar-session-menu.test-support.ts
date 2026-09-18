import type { Page } from "playwright";

export async function openSidebarMenuPage(page: Page, section: "Filters" | "View") {
  const menu = page.locator(".sidebar-session-sort-menu");
  if (await menu.getByRole("menu", { name: section, exact: true }).isVisible()) {
    return menu;
  }
  const back = menu.locator("#sidebar-sessions-back");
  if (await back.isVisible()) {
    await back.click();
  }
  await menu.getByRole("menuitem", { name: new RegExp(`^${section}`) }).click();
  await menu.getByRole("menu", { name: section, exact: true }).waitFor();
  return menu;
}

export async function chooseSidebarMenuOption(
  page: Page,
  label: "Group by" | "Sort by" | "Status" | "Owners" | "Hide empty groups",
  option: string,
) {
  const menu = await openSidebarMenuPage(
    page,
    label === "Status" || label === "Owners" ? "Filters" : "View",
  );
  await menu.getByRole("menuitem", { name: new RegExp(`^${label}:`) }).click();
  await menu.getByRole("option", { name: option, exact: true }).click();
}

export async function closeSidebarMenu(page: Page) {
  const menu = page.locator(".sidebar-session-sort-menu");
  if (await menu.locator("#sidebar-sessions-back").isVisible()) {
    await page.keyboard.press("Escape");
  }
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}
