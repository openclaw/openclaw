import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";

export const sidebarSession = (
  key: string,
  label: string | undefined,
  fields: Partial<GatewaySessionRow> & { updatedAt: number },
) => ({ key, label, kind: "direct", ...fields }) satisfies GatewaySessionRow;

export const sidebarSessionList = (sessions: unknown[], defaults: object, owners: unknown[]) => ({
  ts: 1,
  path: "",
  count: sessions.length,
  defaults,
  owners,
  sessions,
});

export const style = (locator: Locator, property: string) =>
  locator.evaluate((element, key) => getComputedStyle(element).getPropertyValue(key), property);

export const isFocused = (locator: Locator) =>
  locator.evaluate((element) => element === document.activeElement);
export const expectFocused = async (locator: Locator) =>
  expect(await isFocused(locator)).toBe(true);

export async function expectCounts(root: Locator, counts: Record<string, number>) {
  for (const [selector, count] of Object.entries(counts)) {
    expect(await root.locator(selector).count(), selector).toBe(count);
  }
}

export async function expectHorizontalBounds(locator: Locator, width: number) {
  const bounds = (await locator.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
}

export const seedSidebarSettings = (page: Page, baseUrl: string, value: object) =>
  page.addInitScript(({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)), {
    key: controlUiBundledSettingsStorageKey(baseUrl),
    settings: value,
  });
