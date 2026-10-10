import type { Page } from "playwright";

/** Mobile exposes Home through the navigation drawer, not an offscreen click. */
export async function openProgressHomeDock(page: Page): Promise<void> {
  const label = "Talk to your Home agent";
  const toggle = page.getByRole("button", { name: label, exact: true, includeHidden: true });
  await toggle.waitFor({ state: "attached" });
  // Offscreen/inert drawer contents can still have a CSS box. Use the
  // accessibility scope to decide whether the navigation drawer must open.
  const drawer = (await page.getByRole("button", { name: label, exact: true }).count()) === 0;
  if (drawer) {
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  }
  await page.getByRole("button", { name: label, exact: true }).click();
  if (drawer) {
    // The modal drawer covers its topbar toggle; dismiss through its
    // public keyboard action before interacting with the newly opened dock.
    await page.getByRole("dialog", { name: "Navigation", exact: true }).press("Escape");
    await page
      .getByRole("dialog", { name: "Navigation", exact: true })
      .waitFor({ state: "hidden" });
  }
  await page.locator("openclaw-home-session").waitFor();
}
