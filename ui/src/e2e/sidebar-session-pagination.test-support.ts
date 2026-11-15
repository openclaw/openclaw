import type { Locator } from "playwright";
import { expect } from "vitest";

/** Expand one grouped fixture through the published pages, including virtualized rows. */
export async function expandSidebarSessions(section: Locator, total: number): Promise<void> {
  const row = section.locator(".sidebar-session-window > [aria-setsize]").first();
  const size = async () => Number(await row.getAttribute("aria-setsize"));
  const more = section.getByRole("button", { name: "Show more", exact: true });
  await expect.poll(size).toBe(15);
  for (let count = 15; count < total; count += 15) {
    await more.click();
    await expect.poll(size).toBe(Math.min(count + 15, total));
  }
  await expect.poll(() => more.count()).toBe(0);
}
