import type { Locator, Page } from "playwright";
import { expect } from "vitest";

/** Mobile exposes Home through the navigation drawer, not an offscreen click. */
export async function openProgressHomeDock(
  page: Page,
  options: { waitForSession?: boolean } = {},
): Promise<void> {
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
  if (options.waitForSession !== false) {
    await page.locator("openclaw-home-session").waitFor();
  }
}

export async function waitForProgressScrollIdle(thread: Locator) {
  await expect
    .poll(() =>
      thread.evaluate(async (element) => {
        const before = [element.scrollTop, element.scrollHeight, element.clientHeight];
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const after = [element.scrollTop, element.scrollHeight, element.clientHeight];
        return before.every((value, index) => value === after[index]);
      }),
    )
    .toBe(true);
}
