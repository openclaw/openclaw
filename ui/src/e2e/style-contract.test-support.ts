import type { Locator } from "playwright";
import { expect } from "vitest";

export async function expectStyles(
  target: Locator,
  expected: Record<string, unknown>,
  pseudoElement?: string,
) {
  const actual = await target.evaluate(
    (element, { keys, pseudo }) => {
      const style = getComputedStyle(element, pseudo);
      return Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key)]));
    },
    { keys: Object.keys(expected), pseudo: pseudoElement },
  );
  expect(actual).toEqual(expected);
}
