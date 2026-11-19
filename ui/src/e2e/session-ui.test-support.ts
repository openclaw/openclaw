import type { Locator, Page } from "playwright";

/** Wait for an exact label, retaining Playwright's visibility and strictness checks. */
export const waitForSessionText = (scope: Page | Locator, text: string) =>
  scope.getByText(text, { exact: true }).waitFor();
