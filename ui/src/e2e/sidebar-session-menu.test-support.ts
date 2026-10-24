import type { Locator, Page } from "playwright";

export async function openSidebarMenu(page: Page) {
  const menu = page.locator(".sidebar-session-sort-menu");
  const trigger = page.getByRole("button", { name: "Filter & sort", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await menu.getByRole("dialog").waitFor();
  await settleSidebarMenuMotion(menu.getByRole("dialog"));
  return menu;
}

/** Waits for the phone sheet and its choice pages to finish sliding in. */
export async function settleSidebarMenuMotion(locator: Locator) {
  await locator.evaluate((element) =>
    Promise.all(
      [element.closest(".sidebar-session-filter-panel"), element.closest(".picker-select__menu")]
        .flatMap((node) => node?.getAnimations() ?? [])
        .map((animation) => animation.finished),
    ),
  );
}

export async function chooseSidebarMenuOption(
  page: Page,
  label: "Group by" | "Sort by" | "Status" | "Owners" | "Hide empty groups",
  option: string,
) {
  if (label === "Owners") {
    await page.locator("#sidebar-session-owner-title").click();
    await page
      .locator(".sidebar-session-owner-filter")
      .getByRole("option", { name: option, exact: true })
      .click();
    return;
  }
  const menu = await openSidebarMenu(page);
  if (label !== "Status") {
    await menu
      .locator(
        label === "Group by"
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
  await page.locator("#sidebar-session-owner-title").click();
  await page
    .locator(`.sidebar-session-owner-filter [role="option"][data-value="${value}"]`)
    .click();
}
