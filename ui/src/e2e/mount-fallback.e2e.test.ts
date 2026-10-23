import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { pauseVirtualClock, type ControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
const renderEvent = "openclaw-control-ui-rendered";
const loadCountKey = "openclaw.control-ui-e2e.mount-fallback-loads";
const renderCountKey = "openclaw.control-ui-e2e.mount-fallback-renders";
const pageOptions = { serviceWorkers: "block", viewport: { height: 900, width: 1280 } } as const;
const counter = (page: Page, key: string) =>
  page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
let syntheticModuleRenders = false;

async function startRegisteredElementFixture(): Promise<ControlUiE2eServer> {
  const indexHtml = await readFile(indexHtmlPath, "utf8");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const module = pathname === "/src/main.ts" || pathname === "/slow.js";
    const body =
      pathname === "/slow.js"
        ? "export const loaded = true;"
        : pathname === "/src/main.ts"
          ? syntheticModuleRenders
            ? `customElements.define("openclaw-app", class extends HTMLElement {
              connectedCallback() {
                this.textContent = "Application rendered";
                window.dispatchEvent(new Event(${JSON.stringify(renderEvent)}));
              }
            });`
            : 'customElements.define("openclaw-app", class extends HTMLElement {});'
          : pathname === "/"
            ? indexHtml
            : undefined;
    response.statusCode = body === undefined ? 404 : 200;
    if (body !== undefined) {
      response.setHeader(
        "content-type",
        `${module ? "text/javascript" : "text/html"}; charset=utf-8`,
      );
    }
    response.end(body);
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Registered-element fixture did not acquire a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: promisify(server.close.bind(server)),
  };
}

async function preparePage(page: Page): Promise<void> {
  await page.addInitScript(
    ({ loadKey, renderedEvent, renderKey }) => {
      const increment = (key: string) =>
        sessionStorage.setItem(
          key,
          String(Number.parseInt(sessionStorage.getItem(key) ?? "0", 10) + 1),
        );
      increment(loadKey);
      window.addEventListener(renderedEvent, () => increment(renderKey));
    },
    { loadKey: loadCountKey, renderedEvent: renderEvent, renderKey: renderCountKey },
  );
  await page.clock.install();
  await pauseVirtualClock(page);
}

async function exhaustMountRecovery(page: Page): Promise<void> {
  // Every document gets a fresh grace period; only three recovery navigations
  // are allowed before a broken bundle must leave the terminal fallback visible.
  for (let recovery = 1; recovery <= 3; recovery += 1) {
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await page.clock.runFor(12_001);
    const response = await navigation;
    expect(new URL(response!.url()).searchParams.get("openclaw_mount_recovery")).toBe(
      String(recovery),
    );
    expect(await counter(page, loadCountKey)).toBe(String(recovery + 1));
  }
  await page.clock.runFor(12_001);
  await page.getByRole("heading", { name: "Control UI did not start" }).waitFor();
  expect(await page.locator("#openclaw-mount-fallback-summary").textContent()).toContain(
    "A fresh page still could not start the Control UI",
  );
  await page.clock.runFor(60_000);
  expect(await counter(page, loadCountKey)).toBe("4");
}

const registeredElementSuite = createControlUiE2eSuite({
  name: "Control UI static mount fallback E2E",
  startServer: startRegisteredElementFixture,
  startServerBeforeBrowser: true,
});

registeredElementSuite.define(() => {
  it.each([false, true])(
    "preserves a slow module graph (recovery document: %s)",
    async (recovery) => {
      syntheticModuleRenders = true;
      let held!: Awaited<ReturnType<typeof holdModuleResponse>>;
      await registeredElementSuite.withPage(
        pageOptions,
        async ({ page }) => {
          await preparePage(page);
          await page.route("**/src/main.ts", async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: `import "/slow.js";\n${await response.text()}` });
          });
          held = await holdModuleResponse(page, /\/slow\.js$/u);
          const url = new URL(registeredElementSuite.server.baseUrl);
          if (recovery) {
            url.searchParams.set("openclaw_mount_recovery", "1");
          }
          url.searchParams.set("session", "synthetic-session");
          url.hash = "synthetic-fragment";
          await page.goto(url.href, { waitUntil: "commit" });
          await held.request;
          await page.clock.runFor(12_001);

          await page.getByRole("heading", { name: "Control UI is still loading" }).waitFor();
          expect(await counter(page, loadCountKey)).toBe("1");
          await page.getByRole("button", { name: "Keep waiting" }).click();
          await page.clock.runFor(12_001);
          expect(held.requests()).toBe(1);
          expect(await counter(page, loadCountKey)).toBe("1");

          held.release();
          await page.getByText("Application rendered", { exact: true }).waitFor();
          expect(await page.locator("#openclaw-mount-fallback").isHidden()).toBe(true);
          expect(await counter(page, renderCountKey)).toBe("1");
          expect(new URL(page.url()).searchParams.get("session")).toBe("synthetic-session");
          expect(new URL(page.url()).hash).toBe("#synthetic-fragment");
        },
        async () => held?.release(),
      );
    },
  );

  it("shows the fallback when registration never produces an application render", async () => {
    syntheticModuleRenders = false;
    await registeredElementSuite.withPage(pageOptions, async ({ page }) => {
      await preparePage(page);
      await page.goto(registeredElementSuite.server.baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => customElements.get("openclaw-app") !== undefined);

      expect(await page.locator("openclaw-app").textContent()).toBe("");
      expect(await counter(page, renderCountKey)).toBeNull();

      await exhaustMountRecovery(page);

      expect(await page.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Keep waiting" }).isVisible()).toBe(true);
      expect(await counter(page, renderCountKey)).toBeNull();

      const drag = await page.evaluate(() => {
        const fallback = document.getElementById("openclaw-mount-fallback")!;
        const press = (target: Element, button = 0, handled = false) => {
          const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button });
          if (handled) {
            event.preventDefault();
          }
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const withoutBridge = press(fallback);
        const messages: unknown[] = [];
        Object.defineProperty(window, "webkit", {
          configurable: true,
          value: {
            messageHandlers: {
              openclawWindowDrag: { postMessage: (message: unknown) => messages.push(message) },
            },
          },
        });
        try {
          const background = press(fallback);
          const panel = [
            ".mount-fallback__panel",
            ".mount-fallback__panel h1",
            "#openclaw-mount-retry",
            "#openclaw-mount-wait",
          ].map((selector) => press(fallback.querySelector(selector)!));
          const secondary = press(fallback, 2);
          press(fallback, 0, true);
          return { withoutBridge, background, panel, secondary, messages };
        } finally {
          Reflect.deleteProperty(window, "webkit");
        }
      });
      expect(drag).toEqual({
        withoutBridge: false,
        background: true,
        panel: [false, false, false, false],
        secondary: false,
        messages: [{ type: "window-drag" }],
      });

      syntheticModuleRenders = true;
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: "Try again" }).click(),
      ]);
      await page.getByText("Application rendered", { exact: true }).waitFor();
      await page.clock.runFor(12_001);

      expect(await page.locator("#openclaw-mount-fallback").isHidden()).toBe(true);
      expect(await counter(page, renderCountKey)).toBe("1");
    });
  });
});

const runtimeFailureSuite = createControlUiE2eSuite({
  name: "Control UI failed runtime mount E2E",
  startServerBeforeBrowser: true,
});

runtimeFailureSuite.define(() => {
  it("does not complete startup when application runtime creation throws", async () => {
    await runtimeFailureSuite.withPage(pageOptions, async ({ page }) => {
      await preparePage(page);
      await page.addInitScript(() => {
        const browserGetComputedStyle = globalThis.getComputedStyle.bind(globalThis);
        Object.defineProperty(globalThis, "getComputedStyle", {
          configurable: true,
          value: (element: Element, pseudoElement?: string | null) => {
            if (element === document.documentElement) {
              throw new Error("forced application runtime creation failure");
            }
            return browserGetComputedStyle(element, pseudoElement);
          },
        });
      });
      const failed = page.waitForEvent("pageerror", {
        predicate: (error) => error.message === "forced application runtime creation failure",
      });
      await page.goto(runtimeFailureSuite.server.baseUrl, { waitUntil: "domcontentloaded" });
      await failed;

      await exhaustMountRecovery(page);

      expect(await counter(page, renderCountKey)).toBeNull();
    });
  });
});
