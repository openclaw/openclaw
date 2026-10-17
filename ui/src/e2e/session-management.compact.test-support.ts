import type { Locator, Page } from "playwright";
import { waitForPatch } from "./session-management.test-support.ts";

export const button = (root: Page | Locator, name: string | RegExp, exact = true) =>
  root.getByRole("button", { name, exact });
export const menuItem = (root: Page | Locator, name: string | RegExp, exact = true) =>
  root.getByRole("menuitem", { name, exact });
export const visible = (locator: Locator, timeout?: number) =>
  locator.waitFor({ state: "visible", timeout });

export async function bounds(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) {
    throw new Error("Expected visible session geometry");
  }
  return rect;
}
type Rect = Awaited<ReturnType<typeof bounds>>;
export const centerY = (rect: Rect) => rect.y + rect.height / 2;
export const right = (rect: Rect) => rect.x + rect.width;

export function sessionPatch(
  gateway: Parameters<typeof waitForPatch>[0],
  key: string,
  fields: Record<string, unknown>,
) {
  return waitForPatch(
    gateway,
    (params) =>
      params.key === key && Object.entries(fields).every(([name, value]) => params[name] === value),
  );
}

export async function switchAgent(sidebar: Locator, name: string) {
  await button(sidebar, /Switch agent/, false).click();
  await menuItem(sidebar.locator(".sidebar-agent-menu"), name).click();
}
