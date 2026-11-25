import type { Page } from "playwright";
import { expect } from "vitest";

export async function selectAgentFileWorkspace(page: Page, name: string) {
  const select = page.locator(".settings-sidebar__agent openclaw-agent-select");
  await select.locator(".agent-select__trigger").click();
  await select
    .locator(".agent-select__option[data-agent-option]")
    .filter({ hasText: name })
    .click();
  await expect
    .poll(async () => (await select.locator(".agent-select__label").textContent())?.trim())
    .toBe(name);
}
