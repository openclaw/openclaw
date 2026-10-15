import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export function pickerValue(picker: Locator) {
  return picker.locator('[role="option"][aria-selected="true"]').getAttribute("data-value");
}

export async function openPicker(picker: Locator) {
  const trigger = picker.locator(".picker-select__trigger");
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await trigger.click();
  }
  await picker.locator(".picker-select__menu").waitFor({ state: "visible" });
}

export async function selectPickerValue(picker: Locator, value: string) {
  await openPicker(picker);
  await picker.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}

export async function revealChatModelOption(option: Locator, options: { timeout?: number } = {}) {
  await option.waitFor({ ...options, state: "attached" });
  if (!(await option.isVisible())) {
    const providerToggle = option
      .locator("xpath=ancestor::section[@data-chat-model-provider-group][1]")
      .locator("[data-chat-model-provider-toggle]");
    if ((await providerToggle.getAttribute("aria-expanded")) === "false") {
      await providerToggle.click(options);
    }
  }
  await option.waitFor({ ...options, state: "visible" });
}

export async function selectChatModelOption(option: Locator) {
  await revealChatModelOption(option);
  await option.click();
}

export async function openChatModelPicker(scope: Page | Locator) {
  await scope.locator('[data-chat-model-select="true"]').click();
  await expect.poll(() => scope.locator(".chat-controls__model-menu").isVisible()).toBe(true);
}

export async function selectChatModel(scope: Page | Locator, model: string) {
  await openChatModelPicker(scope);
  await selectChatModelOption(scope.locator(`[data-chat-model-option=${JSON.stringify(model)}]`));
}
