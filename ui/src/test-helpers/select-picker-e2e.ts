import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export async function pickerValue(picker: Locator) {
  const trigger = picker.locator(".picker-select__trigger");
  const wasClosed = (await trigger.getAttribute("aria-expanded")) === "false";
  await openPicker(picker);
  try {
    return await picker.locator('[role="option"][aria-selected="true"]').getAttribute("data-value");
  } finally {
    if (wasClosed) {
      await trigger.click();
      await picker.locator(".picker-select__menu").waitFor({ state: "hidden" });
    }
  }
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

type ChatModelOptionOptions = {
  timeout?: number;
  provider?: string;
  runtime?: string;
  default?: boolean;
};

export async function revealChatModelOption(
  scope: Page | Locator,
  model: string,
  options: ChatModelOptionOptions = {},
) {
  const menu = scope.locator(".chat-controls__model-menu:visible");
  await menu.waitFor({ state: "visible", timeout: options.timeout });
  const selector = `[data-chat-model-option=${JSON.stringify(model)}]${
    options.runtime ? `[data-chat-model-runtime=${JSON.stringify(options.runtime)}]` : ""
  }${options.default ? '[data-chat-model-default="true"]' : ""}`;
  const option = menu.locator(selector).first();
  if (!(await option.isVisible())) {
    const provider = options.provider ?? model.split("/")[0];
    const group = menu.locator(`[data-chat-model-provider-group=${JSON.stringify(provider)}]`);
    const toggle = group.locator("[data-chat-model-provider-toggle]");
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
      await toggle.click({ timeout: options.timeout });
      await expect
        .poll(() => toggle.getAttribute("aria-expanded"), { timeout: options.timeout })
        .toBe("true");
    }
    const more = group.locator("[data-chat-model-more-toggle]");
    if (!(await option.isVisible()) && (await more.isVisible())) {
      await more.click({ timeout: options.timeout });
      await more.waitFor({ state: "hidden", timeout: options.timeout });
    }
    // Virtualized rows may not exist until a user narrows the catalog.
    if (!(await option.isVisible())) {
      await menu.locator("[data-chat-model-search]").fill(model);
    }
  }
  await option.waitFor({ state: "visible", timeout: options.timeout });
  return option;
}

export async function selectChatModelOption(
  scope: Page | Locator,
  model: string,
  options: ChatModelOptionOptions = {},
) {
  const option = await revealChatModelOption(scope, model, options);
  await option.click();
}

export async function openChatModelPicker(scope: Page | Locator) {
  await scope.locator('[data-chat-model-select="true"]').click();
  await expect.poll(() => scope.locator(".chat-controls__model-menu").isVisible()).toBe(true);
}

export async function selectChatModel(scope: Page | Locator, model: string) {
  await openChatModelPicker(scope);
  await selectChatModelOption(scope, model);
}
