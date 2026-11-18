import type { Locator } from "playwright";
import { expect } from "vitest";

/** Page a lone session list through its loaded rows, including virtualized rows:
 *  each visit to its end shows the next page, and Show more pages a list that
 *  cannot scroll yet. */
export async function expandSidebarSessions(section: Locator, total: number): Promise<void> {
  const row = section.locator(".sidebar-session-window > [aria-setsize]").first();
  const size = async () => Number(await row.getAttribute("aria-setsize"));
  const more = section.getByRole("button", { name: "Show more", exact: true });
  await expect.poll(size).toBe(15);
  for (let count = 15; count < total; count += 15) {
    const scrolled = await section.evaluate((element) => {
      const canScroll = element.scrollHeight > element.clientHeight;
      element.scrollTop = element.scrollHeight;
      return canScroll;
    });
    if (!scrolled) {
      await more.click();
    }
    await expect.poll(size).toBe(Math.min(count + 15, total));
  }
  await expect.poll(() => more.count()).toBe(0);
}
