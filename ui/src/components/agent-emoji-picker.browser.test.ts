import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import "./agent-emoji-picker.ts";

afterEach(() => document.body.replaceChildren());

it("opens above a modal, focuses search, selects and restores its trigger", async () => {
  const dialog = document.createElement("dialog");
  const picker = document.createElement("openclaw-agent-emoji-picker");
  const onSelect = vi.fn();
  picker.onSelect = onSelect;
  dialog.append(picker);
  document.body.append(dialog);
  dialog.showModal();
  await picker.updateComplete;
  const trigger = picker.querySelector<HTMLButtonElement>(".agent-emoji-picker__trigger")!;
  const search = picker.querySelector<HTMLInputElement>(".emoji-search-panel__search")!;
  const popover = picker.querySelector<HTMLElement>(".agent-emoji-picker__popover")!;
  await page.elementLocator(trigger).click();
  await expect.poll(() => popover.matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(search);
  await page.elementLocator(search).fill("rocket");
  const rocket = picker.querySelector<HTMLButtonElement>('[aria-label="rocket"]')!;
  await page.elementLocator(rocket).click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("🚀");
  await expect.poll(() => popover.matches(":popover-open")).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await page.elementLocator(trigger).click();
  expect(search.value).toBe("");
  picker.disabled = true;
  await picker.updateComplete;
  await expect.poll(() => popover.matches(":popover-open")).toBe(false);
  expect(trigger.disabled).toBe(true);
  dialog.close();
});
