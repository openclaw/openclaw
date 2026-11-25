import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installMockGateway,
  pollLocatorText,
  WORKSPACE,
  PICKED,
} from "./new-session-page.test-support.ts";

export function createPageOpener(suite: Pick<ControlUiE2eSuite, "newBrowserContext">) {
  return async (options: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" }) => {
    const context = await suite.newBrowserContext(options);
    return context.newPage();
  };
}

// Playwright serializes this callback; keep its browser dependencies inside it.
export function deferRecoveryScopeHydration() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const ready = new Promise<void>((resolve) => {
    window.addEventListener("test-release-recovery-scope", () => resolve(), { once: true });
  });
  crypto.subtle.digest = async (algorithm, data) => {
    if (new TextDecoder().decode(data) === "e2e-device-token") {
      await ready;
    }
    return digest(algorithm, data);
  };
}

export async function expectAttribute(locator: Locator, name: string, value: string) {
  await expect.poll(() => locator.getAttribute(name)).toBe(value);
}

export async function expectValue(locator: Locator, value: string) {
  await expect.poll(() => locator.inputValue()).toBe(value);
}

export async function expectLabel(locator: Locator, value: string) {
  await pollLocatorText(locator.locator(".new-session-page__trigger-label")).toBe(value);
}

export function button(scope: Page | Locator, name: string | RegExp, exact = false) {
  return scope.getByRole("button", { name, exact });
}

export async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected visible bounds for " + locator.toString());
  }
  return box;
}

export async function waitForRequestCount(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  count: number,
  ...args: Parameters<typeof gateway.getRequests>
) {
  await expect.poll(async () => (await gateway.getRequests(...args)).length).toBe(count);
}

export function folderListings(
  home: string,
  parent: string | undefined,
  siblings: { name: string; path: string; hidden?: boolean }[] = [],
) {
  return {
    cases: [
      {
        match: { path: WORKSPACE },
        response: {
          path: WORKSPACE,
          home,
          ...(parent ? { parent } : {}),
          entries: [{ name: "packages", path: PICKED }, ...siblings],
        },
      },
      { match: { path: PICKED }, response: { path: PICKED, parent: WORKSPACE, home, entries: [] } },
    ],
  };
}
