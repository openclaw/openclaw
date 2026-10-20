import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";

export function expectFocused(locator: Locator, within = false) {
  return expect
    .poll(() =>
      locator.evaluate(
        (element, subtree) =>
          subtree ? element.matches(":focus-within") : element === document.activeElement,
        within,
      ),
    )
    .toBe(true);
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

export function expectText(locator: Locator, text: string) {
  return expect.poll(() => locator.textContent()).toContain(text);
}

export function expectAttribute(locator: Locator, name: string, value: string) {
  return expect.poll(() => locator.getAttribute(name)).toBe(value);
}

export function expectCount(locator: Locator, count: number) {
  return expect.poll(() => locator.count()).toBe(count);
}

export function expectVisible(locator: Locator, visible = true) {
  return expect.poll(() => locator.isVisible()).toBe(visible);
}

export function expectPath(page: Page, pathname: string) {
  return expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
}

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
  initialEntries: Record<string, unknown>,
  persistenceKey?: string,
) {
  return page.evaluate(
    ({ initial, storageKey }) => {
      const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
      const saved = storageKey ? sessionStorage.getItem(storageKey) : null;
      const values: Record<string, unknown> = saved ? JSON.parse(saved) : initial;
      mock.setRequestHandler("users.prefs.get", ({ respond }) =>
        respond({ status: "ok", entries: values }),
      );
      mock.setRequestHandler("users.prefs.set", ({ params, respond }) => {
        const request = params as {
          entries: Record<string, unknown>;
          expectedEntries?: Record<string, unknown>;
        };
        if (
          storageKey &&
          Object.entries(request.expectedEntries ?? {}).some(
            ([key, value]) => JSON.stringify(values[key] ?? null) !== JSON.stringify(value),
          )
        ) {
          respond({ status: "conflict" });
          return;
        }
        Object.assign(values, request.entries);
        if (storageKey) {
          sessionStorage.setItem(storageKey, JSON.stringify(values));
        }
        respond({ status: "ok" });
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
  directory: string,
  name: string,
  surface: Locator,
  content: Locator[],
) {
  const frame = await takeControlUiScreenshotFrame(surface.page(), surface, content, {
    animations: "disabled",
  });
  await writeFile(path.join(directory, name), frame.png);
}

export function catalogList(fixture: {
  id: string;
  label: string;
  host: string;
  thread: string;
  name: string;
  status: string;
  archive: boolean;
  startTerminal?: boolean;
}) {
  const { id, label, host, thread, name, status, archive, startTerminal } = fixture;
  return {
    catalogs: [
      {
        id,
        label,
        capabilities: Object.assign(
          { continueSession: true, archive },
          startTerminal === undefined ? {} : { startTerminal },
        ),
        hosts: [
          {
            hostId: "gateway:local",
            label: host,
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: thread,
                name,
                status,
                archived: false,
                canContinue: true,
                canArchive: archive,
              },
            ],
          },
        ],
      },
    ],
  };
}
