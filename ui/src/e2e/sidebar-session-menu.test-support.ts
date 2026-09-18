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
  if (label === "Owners") {
    await menu.locator("#sidebar-sessions-owner").selectOption({ label: option });
    return;
  }
  await menu
    .getByRole("radiogroup", { name: label, exact: true })
    .getByRole("radio", { name: option, exact: true })
    .check();
}

export async function closeSidebarMenu(page: Page) {
  const menu = page.locator(".sidebar-session-sort-menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}
