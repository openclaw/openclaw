import type { Browser, BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

export async function expectText(target: Locator, text: string) {
  await expect.poll(() => target.textContent()).toContain(text);
}

export async function expectCount(target: Locator, count: number, options?: { timeout: number }) {
  await expect.poll(() => target.count(), options).toBe(count);
}

export async function expectAttribute(target: Locator, name: string, value: string | null) {
  await expect.poll(() => target.getAttribute(name)).toBe(value);
}

export async function expectVisible(target: Locator, visible = true) {
  await expect.poll(() => target.isVisible()).toBe(visible);
}

export async function expectFocused(target: Locator) {
  await expect
    .poll(() => target.evaluate((element) => element === document.activeElement))
    .toBe(true);
}

export async function withSessionPage(
  suite: { readonly browser: Browser },
  run: (page: Page) => Promise<void>,
  options: BrowserContextOptions = createControlUiE2eContextOptions(),
) {
  const context = await suite.browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}
