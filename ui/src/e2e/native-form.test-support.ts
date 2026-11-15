import type { Locator, Page } from "playwright";
import { expect } from "vitest";

// Keep accessible-name matching exact across native forms and their nested panels.
export function nativeForm(root: Page | Locator) {
  const field = (name: string) => root.getByLabel(name, { exact: true });
  return {
    button: (name: string) => root.getByRole("button", { name, exact: true }),
    field,
    heading: (name: string) => root.getByRole("heading", { name, exact: true }),
    text: (text: string) => root.getByText(text, { exact: true }),
  };
}

export async function expectControl(
  control: Locator,
  expected: Partial<{
    value: string;
    type: string | null;
    visible: boolean;
    disabled: boolean;
    enabled: boolean;
  }>,
) {
  const read = {
    value: () => control.inputValue(),
    type: () => control.getAttribute("type"),
    visible: () => control.isVisible(),
    disabled: () => control.isDisabled(),
    enabled: () => control.isEnabled(),
  };
  const actual: Record<string, unknown> = {};
  for (const key of ["value", "type", "visible", "disabled", "enabled"] as const) {
    if (key in expected) {
      actual[key] = await read[key]();
    }
  }
  expect(actual).toMatchObject(expected);
}
