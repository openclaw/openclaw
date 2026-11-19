import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";

type Prefs = Record<string, unknown>;

function hasFocus(element: Element, within: boolean) {
  return within ? element.matches(":focus-within") : element === document.activeElement;
}

export function expectFocused(locator: Locator, within = false) {
  return expect.poll(() => locator.evaluate(hasFocus, within)).toBe(true);
}

export async function pressAndExpectFocus(
  page: Page,
  key: string,
  target: Locator,
  within = false,
) {
  await page.keyboard.press(key);
  await expectFocused(target, within);
}

export { expectText, expectAttribute, expectCount } from "./session-page.test-support.ts";
export const expectVisible = (locator: Locator, visible = true) =>
  expect.poll(() => locator.isVisible()).toBe(visible);
export const expectPath = (page: Page, pathname: string) =>
  expect.poll(() => new URL(page.url()).pathname).toBe(pathname);

export function mockRequests(page: Page, method: string) {
  return page.evaluate((name) => {
    const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
    if (!gateway) {
      throw new Error("Mock Gateway is not installed");
    }
    return gateway.findRequests(name);
  }, method);
}

export function installPreferenceServer(
  page: Page,
  initialEntries: Prefs,
  persistenceKey?: string,
) {
  return page.evaluate(
    ({ initial, storageKey }) => {
      const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
      const saved = storageKey ? sessionStorage.getItem(storageKey) : null;
      const values: Prefs = saved ? JSON.parse(saved) : initial;
      mock.setRequestHandler("users.prefs.get", ({ respond }) =>
        respond({ status: "ok", entries: values }),
      );
      mock.setRequestHandler("users.prefs.set", ({ params, respond }) => {
        const { entries, expectedEntries } = params as {
          entries: Prefs;
          expectedEntries?: Prefs;
        };
        const conflict =
          storageKey &&
          Object.entries(expectedEntries ?? {}).some(
            ([key, value]) => JSON.stringify(values[key] ?? null) !== JSON.stringify(value),
          );
        if (!conflict) {
          Object.assign(values, entries);
          if (storageKey) {
            sessionStorage.setItem(storageKey, JSON.stringify(values));
          }
        }
        respond({ status: conflict ? "conflict" : "ok" });
      });
    },
    { initial: initialEntries, storageKey: persistenceKey },
  );
}

export function seedStorage(page: Page, entries: Record<string, string>, onceKey?: string) {
  return page.addInitScript(
    ({ values, once }) => {
      if (once && sessionStorage.getItem(once)) {
        return;
      }
      if (once) {
        sessionStorage.setItem(once, "true");
      }
      for (const [key, value] of Object.entries(values)) {
        localStorage.setItem(key, value);
      }
    },
    { values: entries, once: onceKey },
  );
}

export async function captureFrame(
  dir: string,
  name: string,
  surface: Locator,
  content: Locator[],
) {
  const frame = await takeControlUiScreenshotFrame(surface.page(), surface, content, {
    animations: "disabled",
  });
  await writeFile(path.join(dir, name), frame.png);
}

export function catalogList(
  fixture: Record<"id" | "label" | "host" | "thread" | "name" | "status", string> & {
    archive: boolean;
    startTerminal?: boolean;
  },
) {
  const { id, label, host, thread, name, status, archive, startTerminal } = fixture;
  const session = {
    threadId: thread,
    name,
    status,
    archived: false,
    canContinue: true,
    canArchive: archive,
  };
  const gateway = {
    hostId: "gateway:local",
    label: host,
    kind: "gateway",
    connected: true,
    sessions: [session],
  };
  const capabilities = Object.assign(
    { continueSession: true, archive },
    startTerminal === undefined ? {} : { startTerminal },
  );
  return {
    catalogs: [{ id, label, capabilities, hosts: [gateway] }],
  };
}
