import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export function expectFocused(locator: Locator, within = false) {
  return expect
    .poll(() =>
      locator.evaluate(
        (element, subtree) =>
          subtree ? element.matches(":focus-within") : element === document.activeElement,
        within,
      ),
    )
    .toBe(true);
}

export async function pressAndExpectFocus(
  page: Page,
  key: string,
  target: Locator,
  within = false,
) {
  await page.keyboard.press(key);
  await expectFocused(target, within);
}
