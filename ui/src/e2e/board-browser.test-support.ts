import type { Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe } from "vitest";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { acquireGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.listener.js";
import type { TestPortClaim } from "../../../src/test-utils/port-claims.js";
import {
  canRunPlaywrightChromium,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

export async function closeBoardTestServer(server: Server | undefined) {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

export function createBoardE2eSuite(
  name: string,
  options: {
    sandbox?: boolean;
    browserLaunchOptions?: Omit<
      NonNullable<Parameters<typeof chromium.launch>[0]>,
      "executablePath"
    >;
    beforeStart?: () => Promise<void>;
    afterSandboxClose?: () => Promise<void>;
  } = {},
) {
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  const define =
    available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
      ? describe
      : describe.skip;
  let browser: Browser;
  let controlUi: ControlUiE2eServer;
  let sandbox: Server;
  let portClaim: TestPortClaim | undefined;
  const contexts = new Set<BrowserContext>();
  return {
    get baseUrl() {
      return controlUi.baseUrl;
    },
    get sandboxPort() {
      if (!portClaim) {
        throw new Error("Board sandbox port has not been acquired");
      }
      return portClaim.port;
    },
    async newPage(contextOptions: Parameters<Browser["newContext"]>[0] = {}) {
      const context = await browser.newContext(contextOptions);
      contexts.add(context);
      return context.newPage();
    },
    async openDashboard(page: Page, sessionKey: string, waitForSurface = true) {
      const storageKey = controlUiBundledSettingsStorageKey(controlUi.baseUrl);
      await page.addInitScript(
        ({ storageKey: key, sessionKey: session }) => {
          // Opaque widget frames do not own dashboard settings.
          if (window !== window.top) {
            return;
          }
          const settings: Record<string, unknown> = JSON.parse(localStorage.getItem(key) ?? "{}");
          settings.boardSessionViews = { [session]: { activeTabId: "main" } };
          localStorage.setItem(key, JSON.stringify(settings));
        },
        { storageKey, sessionKey },
      );
      await page.goto(controlUiSessionUrl(controlUi.baseUrl, sessionKey, "dashboard"));
      if (waitForSurface) {
        await page.locator(".board-session-surface").waitFor();
      }
    },
    define(tests: () => void) {
      define(name, () => {
        beforeAll(async () => {
          await options.beforeStart?.();
          controlUi = await startControlUiE2eServer();
          if (options.sandbox !== false) {
            portClaim = await acquireGatewayE2ePortBlock();
            sandbox = createSandboxHostHttpServer();
            const port = portClaim.port;
            await new Promise<void>((resolve) => {
              sandbox.listen(port, "127.0.0.1", resolve);
            });
          }
          browser = await chromium.launch({ executablePath, ...options.browserLaunchOptions });
        }, 120_000);
        afterAll(async () => {
          for (const context of contexts) {
            await context.close();
          }
          await browser?.close();
          await closeBoardTestServer(sandbox);
          await portClaim?.release();
          await options.afterSandboxClose?.();
          await controlUi?.close();
        });
        tests();
      });
    },
  };
}
