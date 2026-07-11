// Control UI tests cover MCP Apps under the Gateway's production CSP boundary.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTROL_UI_MCP_APP_SANDBOX_PATH,
  CONTROL_UI_MCP_APP_SANDBOX_TICKET_ATTRIBUTE,
} from "../../../src/gateway/control-ui-contract.ts";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import {
  buildControlUiMcpAppSandboxCspHeader,
  CONTROL_UI_MCP_APP_SANDBOX_PROXY_HTML,
  type ControlUiMcpAppCsp,
} from "../../../src/gateway/control-ui-mcp-app-sandbox.ts";
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
const sandboxTicket = "e2e.signed-ticket";

let browser: Browser;
let server: ControlUiE2eServer;

const appHtml = `<!doctype html>
<html>
<body>
  <div id="status">starting</div>
  <script>
    const seen = new Set();
    const render = () => {
      document.querySelector("#status").textContent = [...seen].sort().join(" ");
    };
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.id === 1 && message?.result?.protocolVersion) {
        seen.add("initialized");
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/initialized"
        }, "*");
        render();
        return;
      }
      if (message?.method === "ui/notifications/tool-input") {
        seen.add("input:" + message.params.arguments.shape);
        render();
      }
      if (message?.method === "ui/notifications/tool-result") {
        seen.add("result:" + message.params.structuredContent.status);
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height: 360 }
        }, "*");
        render();
      }
    });
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {}
    }, "*");
  </script>
</body>
</html>`;

describeControlUiE2e("MCP App sandbox proxy", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("runs the app handshake under the production page CSP without granting permissions", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          timestamp: Date.now(),
          content: [
            {
              type: "toolCall",
              name: "diagrams_create_view",
              id: "call-1",
              arguments: { shape: "circle" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "diagrams_create_view",
          timestamp: Date.now() + 1,
          content: [{ type: "text", text: "rendered" }],
          details: {
            mcpApp: {
              toolName: "diagrams_create_view",
              toolInput: { shape: "circle" },
              resource: {
                uri: "ui://diagrams/app.html",
                html: appHtml,
                permissions: ["camera", "microphone", "geolocation", "clipboardWrite"],
                prefersBorder: true,
              },
              result: {
                content: [{ type: "text", text: "rendered" }],
                structuredContent: { status: "ready" },
              },
            },
          },
        },
      ],
    });
    await page.route(`**${CONTROL_UI_MCP_APP_SANDBOX_PATH}?*`, async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("ticket")).toBe(sandboxTicket);
      const csp = JSON.parse(url.searchParams.get("csp") ?? "{}") as ControlUiMcpAppCsp;
      await route.fulfill({
        body: CONTROL_UI_MCP_APP_SANDBOX_PROXY_HTML,
        contentType: "text/html; charset=utf-8",
        headers: {
          "cache-control": "no-store",
          "content-security-policy": buildControlUiMcpAppSandboxCspHeader(csp),
          "x-frame-options": "SAMEORIGIN",
        },
      });
    });
    await page.route(`${server.baseUrl}chat`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /<html\b/i,
        `<html ${CONTROL_UI_MCP_APP_SANDBOX_TICKET_ATTRIBUTE}="${sandboxTicket}"`,
      );
      await route.fulfill({
        body,
        headers: {
          ...response.headers(),
          "content-security-policy": buildControlUiCspHeader({
            inlineScriptHashes: computeInlineScriptHashes(body),
          }),
        },
        response,
      });
    });

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.headers()["content-security-policy"]).toBeDefined();
      await gateway.waitForRequest("chat.startup");
      const toolRow = page.locator(".chat-tool-msg-summary").last();
      await toolRow.waitFor({ state: "visible", timeout: 10_000 });
      if ((await toolRow.getAttribute("aria-expanded")) !== "true") {
        await toolRow.click();
      }
      const outerFrame = page.locator(
        '.chat-tool-card__preview[data-kind="mcp-app"] > .chat-tool-card__preview-panel iframe',
      );
      await outerFrame.waitFor({ state: "visible", timeout: 10_000 });
      expect(await outerFrame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(await outerFrame.getAttribute("allow")).toBeNull();
      await expect
        .poll(() =>
          page
            .frameLocator(".chat-tool-card__preview-frame--mcp-app")
            .locator("iframe")
            .getAttribute("sandbox"),
        )
        .toBe("allow-scripts allow-same-origin");
      expect(
        await page
          .frameLocator(".chat-tool-card__preview-frame--mcp-app")
          .locator("iframe")
          .getAttribute("allow"),
      ).toBeNull();
      const app = page
        .frameLocator(".chat-tool-card__preview-frame--mcp-app")
        .frameLocator("iframe");
      await app.getByText("initialized input:circle result:ready").waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await expect.poll(() => outerFrame.getAttribute("style")).toContain("height: 360px");
    } finally {
      await context.close();
    }
  });
});
