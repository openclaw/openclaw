import type { Page } from "playwright";
import { expect } from "vitest";

/** Follow the public document's login handoff without exposing browser fragment credentials. */
export async function enterControlUiSession(page: Page): Promise<void> {
  const login = page.getByRole("link", { name: "Log in", exact: true });
  const entryUrl = await login.evaluate((element: HTMLAnchorElement) => element.href);
  const [navigation] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().isNavigationRequest() && response.url() === entryUrl,
    ),
    login.click(),
  ]);
  expect(navigation.status()).toBe(200);
}
