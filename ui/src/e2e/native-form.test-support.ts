import type { Locator, Page } from "playwright";

// Keep accessible-name matching exact across native forms and their nested panels.
export function nativeForm(root: Page | Locator) {
  return {
    button: (name: string) => root.getByRole("button", { name, exact: true }),
    field: (name: string) => root.getByLabel(name, { exact: true }),
    heading: (name: string) => root.getByRole("heading", { name, exact: true }),
    text: (text: string) => root.getByText(text, { exact: true }),
  };
}
