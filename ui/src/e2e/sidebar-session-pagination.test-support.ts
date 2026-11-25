import type { Locator } from "playwright";
import { expect } from "vitest";

/** Press Show more without Playwright's scroll into view: in a lone list that
 *  scroll reaches the list's end, which shows a page by itself. */
export async function showNextSidebarPage(more: Locator): Promise<void> {
  await more.evaluate((button: HTMLElement) => button.click());
}

/** Expand one grouped fixture through the published pages, including virtualized rows. */
export async function expandSidebarSessions(section: Locator, total: number): Promise<void> {
  const row = section.locator(".sidebar-session-window > [aria-setsize]").first();
  const size = async () => Number(await row.getAttribute("aria-setsize"));
  const more = section.getByRole("button", { name: "Show more", exact: true });
  await expect.poll(size).toBe(15);
  for (let count = 15; count < total; count += 15) {
    await showNextSidebarPage(more);
    await expect.poll(size).toBe(Math.min(count + 15, total));
  }
  await expect.poll(() => more.count()).toBe(0);
}
