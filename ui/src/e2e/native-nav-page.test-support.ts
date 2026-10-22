import type { BrowserContext, Page } from "playwright";
import { afterEach, expect } from "vitest";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { failNextDeviceIdentityMint } from "./chat-side-panel.test-support.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

export function createNativeNavPageOpener(suite: ReturnType<typeof createControlUiE2eSuite>) {
  let context: BrowserContext | undefined;

  afterEach(async () => {
    if (context) {
      await suite.closeBrowserContext(context);
    }
    context = undefined;
  });

  async function openPage(options: {
    beforeNavigate?: (page: Page) => Promise<void>;
    colorScheme?: "dark" | "light";
    deviceLess?: boolean;
    hasTouch?: boolean;
    height?: number;
    nativeNav?: boolean;
    pathname?: string;
    readySelector?: string;
    scenario?: ControlUiMockGatewayScenario;
    webChrome?: boolean;
    width?: number;
  }) {
    context = await suite.newBrowserContext({
      colorScheme: options.colorScheme,
      hasTouch: options.hasTouch,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: options.height ?? 900, width: options.width ?? 1280 },
    });
    const page = await context.newPage();
    if (options.deviceLess) {
      await failNextDeviceIdentityMint(page);
    }
    if (options.nativeNav) {
      // Mirrors the WKUserScript in DashboardWindowController.installNativeChromeScript,
      // which runs at document end. Playwright init scripts fire before
      // document.documentElement exists, so defer until the DOM is parsed.
      await page.addInitScript(() => {
        const nativeWindow = window as Window & {
          openclawNavMessages?: unknown[];
        };
        nativeWindow.openclawNavMessages = [];
        Object.defineProperty(window, "webkit", {
          configurable: true,
          value: {
            messageHandlers: {
              openclawNav: {
                postMessage(message: unknown) {
                  nativeWindow.openclawNavMessages?.push(message);
                },
              },
            },
          },
        });
        const stamp = () =>
          document.documentElement.classList.add("openclaw-native-macos", "openclaw-native-nav");
        if (document.documentElement) {
          stamp();
        } else {
          document.addEventListener("DOMContentLoaded", stamp);
        }
      });
    }
    if (options.webChrome) {
      await installNativeWebChrome(page);
    }
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      ...options.scenario,
    });
    await options.beforeNavigate?.(page);
    const response = await page.goto(`${suite.server.baseUrl}${options.pathname ?? ""}`, {
      waitUntil: options.beforeNavigate ? "domcontentloaded" : "load",
    });
    expect(response?.status()).toBe(200);
    // The rail only becomes visible on desktop widths; drawer widths keep
    // the sidebar hidden, so wait for DOM attachment instead of visibility.
    await page.locator(options.readySelector ?? ".sidebar-rail").waitFor({ state: "attached" });
    if (options.scenario) {
      await gateway.waitForRequest("sessions.list");
    }
    return page;
  }

  return openPage;
}
