import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";
import { AgentEmojiPicker } from "./agent-emoji-picker.tsx";

afterEach(() => document.body.replaceChildren());

it("opens above a modal, focuses search, selects and restores its trigger", async () => {
  const dialog = document.createElement("dialog");
  const onSelect = vi.fn();
  document.body.append(dialog);
  dialog.showModal();
  const [disabled, setDisabled] = createSignal(false);
  const view = mountSolid(
    () =>
      createComponent(AgentEmojiPicker, {
        onSelect,
        get disabled() {
          return disabled();
        },
      }),
    { container: dialog },
  );
  flush();
  const picker = view.container.querySelector<HTMLElement>("openclaw-agent-emoji-picker")!;
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
  setDisabled(true);
  flush();
  await expect.poll(() => popover.matches(":popover-open")).toBe(false);
  expect(trigger.disabled).toBe(true);
  dialog.close();
});
