import type { Server } from "node:http";
import type { Browser, Page } from "playwright";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { acquireGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.listener.js";
import type { TestPortClaim } from "../../../src/test-utils/port-claims.js";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
    browserLaunchOptions?: Parameters<typeof createControlUiE2eSuite>[0]["browserLaunchOptions"];
    beforeStart?: () => Promise<void>;
    afterSandboxClose?: () => Promise<void>;
  } = {},
) {
  let controlUi: ControlUiE2eServer;
  let sandbox: Server;
  let portClaim: TestPortClaim | undefined;
  const close = async () => {
    await closeBoardTestServer(sandbox);
    await portClaim?.release();
    await options.afterSandboxClose?.();
    await controlUi?.close();
  };
  const suite = createControlUiE2eSuite({
    name,
    setupTimeoutMs: 120_000,
    startServerBeforeBrowser: true,
    browserLaunchOptions: options.browserLaunchOptions,
    async startServer() {
      try {
        await options.beforeStart?.();
        controlUi = await startControlUiE2eServer();
        if (options.sandbox !== false) {
          portClaim = await acquireGatewayE2ePortBlock();
          sandbox = createSandboxHostHttpServer();
          const { port } = portClaim;
          await new Promise<void>((resolve) => {
            sandbox.listen(port, "127.0.0.1", resolve);
          });
        }
        return { baseUrl: controlUi.baseUrl, close };
      } catch (error) {
        await close();
        throw error;
      }
    },
  });
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
      return (await suite.newBrowserContext(contextOptions)).newPage();
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
    define: suite.define,
  };
}
