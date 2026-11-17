import type { Locator } from "playwright";
import { expect } from "vitest";

/** A lone session list shows every loaded row, virtualized rows included, without Show more. */
export async function expectAllSidebarSessions(section: Locator, total: number): Promise<void> {
  const row = section.locator(".sidebar-session-window > [aria-setsize]").first();
  await expect.poll(async () => Number(await row.getAttribute("aria-setsize"))).toBe(total);
  expect(await section.getByRole("button", { name: "Show more", exact: true }).count()).toBe(0);
}
