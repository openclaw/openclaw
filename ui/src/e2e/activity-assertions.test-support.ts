import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export const expectText = (target: Locator) => expect.poll(() => target.textContent());
export const expectCount = (target: Locator) => expect.poll(() => target.count());
export const expectAttribute = (target: Locator, name: string) =>
  expect.poll(() => target.getAttribute(name));
export const showText = (target: Locator | Page, text: string, exact = true) =>
  target.getByText(text, { exact }).waitFor();
export const showHeading = (page: Page, name: string) =>
  page.getByRole("heading", { name }).waitFor();

export function setVisibility(page: Page, state: "hidden" | "visible", dispatchPageShow = false) {
  return page.evaluate(
    ({ visibility, pageshow }) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
      document.dispatchEvent(new Event("visibilitychange"));
      if (pageshow) {
        globalThis.dispatchEvent(new Event("pageshow"));
      }
    },
    { visibility: state, pageshow: dispatchPageShow },
  );
}

export function scrollRemainder(target: Locator) {
  return target.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

export function styles(target: Locator, properties: string[]) {
  return target.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return names.map((name) => style.getPropertyValue(name));
  }, properties);
}
