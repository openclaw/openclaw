import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import {
  activateSelfRemovingControl,
  actionOpacity,
  controlUiSessionPath,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

type GatewayOptions = NonNullable<Parameters<typeof installMockGateway>[1]>;
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
type Fields = Record<string, unknown>;
export function installSessionRows(page: Page, rows: unknown[], options: GatewayOptions = {}) {
  return installMockGateway(page, {
    ...options,
    methodResponses: { "sessions.list": sessionsListResponse(rows), ...options.methodResponses },
  });
}
export const mainAndResearchAgents = {
  agents: [
    { id: "main", name: "Main" },
    { id: "research", name: "Research" },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
};
export function sessionPage(rows: readonly unknown[], offset: number, limit: number) {
  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    ...sessionsListResponse(page, {
      offset,
      totalCount: rows.length,
      hasMore: nextOffset < rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
    }),
    limitApplied: limit,
  };
}
export const requestCount = async (gateway: Gateway, method: string, match?: Fields) =>
  (await gateway.getRequests(method, match)).length;
export async function expectNoRequests(gateway: Gateway, ...methods: string[]) {
  for (const method of methods) {
    expect(await gateway.getRequests(method)).toEqual([]);
  }
}
export const expectSessionPath = (page: Page, key: string) =>
  expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
export const expectText = (locator: Locator, text: string) =>
  expect.poll(() => locator.textContent()).toContain(text);
export const expectCount = (locator: Locator, count: number) =>
  expect.poll(() => locator.count()).toBe(count);
export const sessionRows = (root: Page | Locator) => (key: string) =>
  root.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
export const expectRightPadding = (locator: Locator, value: string) =>
  expect
    .poll(() => locator.evaluate((element) => getComputedStyle(element).paddingRight))
    .toBe(value);
export async function forEachActionMode(
  page: Page,
  row: Locator,
  controls: Locator[],
  check: () => Promise<void>,
) {
  for (const mode of ["hover", "focus"] as const) {
    if (mode === "hover") {
      await row.hover();
    } else {
      await page.mouse.move(0, 0);
      await button(row, "Pin session", false).focus();
    }
    for (const control of controls) {
      await expect.poll(() => actionOpacity(control)).toBe("1");
    }
    await check();
  }
}

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

export function sessionPatch(gateway: Gateway, key: string, fields: Fields) {
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

export async function archiveSession(
  page: Page,
  row: Locator,
  surface: "header" | "sidebar" | "list",
) {
  if (surface === "header") {
    await page.locator(".chat-header-session-menu__trigger").click();
  } else if (surface === "sidebar") {
    await row.hover();
    await row.click({ button: "right" });
  } else {
    await button(row, "Open session menu", false).click();
  }
  const menu = surface === "header" ? "openclaw-chat-header-session-menu" : "openclaw-session-menu";
  await activateSelfRemovingControl(menuItem(page.locator(menu), "Archive session"));
}
