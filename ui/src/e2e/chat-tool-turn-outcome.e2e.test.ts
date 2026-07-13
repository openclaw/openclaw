// Control UI E2E tests cover autonomous tool-turn outcome rendering.
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

let browser: Browser;
let server: ControlUiE2eServer;

function failedTool(timestamp: number) {
  return {
    role: "toolResult",
    toolName: "shell",
    content: JSON.stringify({ status: "failed", exitCode: 1 }),
    isError: true,
    timestamp,
  };
}

describeControlUiE2e("Control UI autonomous tool-turn outcomes", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps an earlier autonomous failure visible after a later turn recovers", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        failedTool(1),
        {
          role: "assistant",
          content: [{ type: "text", text: "Start the next autonomous task." }],
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          senderLabel: "Forwarded from main",
          timestamp: 2,
        },
        failedTool(3),
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered on the next autonomous turn." }],
          timestamp: 4,
        },
      ],
    });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("Recovered on the next autonomous turn.", { exact: true }).waitFor();

    expect(await page.locator(".chat-tool-msg-summary__label").allTextContents()).toEqual([
      "Tool error",
      "Tool output",
    ]);
    await context.close();
  });
});
