import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const screenshotPath = process.env.OPENCLAW_TERMINAL_REPAINT_SCREENSHOT?.trim();

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI terminal repaint", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps one interactive terminal clean across repeated hide and show cycles", async () => {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1180, height: 520 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: "ws://gateway.example.test",
        token: "test",
      };
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "terminal-repaint-e2e",
          shell: "/bin/zsh",
        },
      },
      terminalEnabled: true,
    });

    try {
      await page.goto(server.baseUrl);
      await gateway.waitForRequest("connect");
      await page.keyboard.press("Control+Backquote");
      await gateway.waitForRequest("terminal.open");
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "terminal-repaint-e2e",
        seq: 0,
        data: "terminal repaint sentinel\r\n$ ",
      });

      const hideTerminal = page.getByRole("button", { name: "Hide terminal" });
      const terminalCanvas = page.locator(".tp-host canvas");
      await terminalCanvas.waitFor({ state: "visible" });

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await hideTerminal.click();
        await expect.poll(() => terminalCanvas.count()).toBe(0);
        await page.keyboard.press("Control+Backquote");
        await terminalCanvas.waitFor({ state: "visible" });
      }

      await terminalCanvas.click();
      await page.keyboard.type("echo repaint");
      await expect
        .poll(async () => (await gateway.getRequests("terminal.input")).length)
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);

      if (screenshotPath) {
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath });
      }
    } finally {
      await context.close();
    }
  });
});
