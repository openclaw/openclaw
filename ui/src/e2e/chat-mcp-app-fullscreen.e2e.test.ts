import fs from "node:fs/promises";
import path from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps/app-bridge";
import { chromium, webkit } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { acquireGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.listener.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const sessionKey = "agent:main:mcp-fullscreen-proof";
const sandbox = createSandboxHostHttpServer();
let server: Awaited<ReturnType<typeof startControlUiE2eServer>>;
let claim: Awaited<ReturnType<typeof acquireGatewayE2ePortBlock>>;
let proof: string;

beforeAll(async () => {
  proof = createControlUiE2eArtifactDir("chat-mcp-fullscreen");
  server = await startControlUiE2eServer();
  claim = await acquireGatewayE2ePortBlock();
  await new Promise<void>((resolve) => {
    sandbox.listen(claim.port, "127.0.0.1", resolve);
  });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((resolve) => {
    sandbox.close(() => resolve());
  });
  await claim?.release();
  await server?.close();
}, 120_000);

const html =
  "<!doctype html><style>html,body{margin:0;height:100%;font:20px system-ui}body{background:#fff}.toolbar{padding:16px}svg{display:block;width:100%;height:calc(100% - 64px)}</style>" +
  '<div class="toolbar"><button id="edit">Edit</button> <span>MCP App editor</span></div>' +
  '<svg viewBox="0 0 800 450"><rect x="90" y="100" width="240" height="100" rx="18" fill="#a5d8ff" stroke="#222"/><text x="160" y="155">This chat</text><path d="M340 150h110m-12-10 12 10-12 10" stroke="#222" fill="none"/><rect x="465" y="100" width="240" height="100" rx="18" fill="#b2f2bb" stroke="#222"/><text x="505" y="155">Excalidraw app</text></svg>' +
  '<script>const send = message => parent.postMessage({jsonrpc:"2.0",...message}, "*");' +
  'addEventListener("message", event => {if(event.data?.id===1 && event.data.result) send({method:"ui/notifications/initialized",params:{}});});' +
  'document.querySelector("#edit").onclick=()=>send({id:2,method:"ui/request-display-mode",params:{mode:"fullscreen"}});' +
  'send({id:1,method:"ui/initialize",params:{protocolVersion:' +
  JSON.stringify(LATEST_PROTOCOL_VERSION) +
  ',appInfo:{name:"Fullscreen proof",version:"1"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]}}});</script>';

it.each(["chromium", "webkit"] as const)(
  "fills the expanded transcript app in %s and restores inline layout",
  async (engine) => {
    const browser = await { chromium, webkit }[engine].launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "canvas",
                preview: {
                  kind: "canvas",
                  surface: "assistant_message",
                  render: "url",
                  title: "Excalidraw fullscreen proof",
                  preferredHeight: 450,
                  mcpApp: { viewId: "fullscreen-view" },
                },
              },
            ],
            timestamp: 1,
          },
        ],
        methodResponses: {
          "mcp.app.view": {
            sandboxUrl: "/mcp-app-sandbox",
            sandboxPort: claim.port,
            html,
            toolInput: {},
            toolResult: { content: [] },
            messageSupported: false,
            updateModelContextSupported: false,
          },
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      const host = page.locator("mcp-app-view");
      const outer = host.locator("iframe");
      const app = outer.contentFrame().frameLocator("iframe");
      await app.getByRole("button", { name: "Edit", exact: true }).click();
      await host.locator(".exit-fullscreen").waitFor();
      const measure = () =>
        host.evaluate((element) => {
          const mount = element.querySelector(".mount")!;
          const frame = element.querySelector("iframe")!;
          return {
            viewport: innerHeight,
            host: element.getBoundingClientRect().height,
            mount: mount.getBoundingClientRect().height,
            iframe: frame.getBoundingClientRect().height,
            display: getComputedStyle(element).display,
          };
        });
      const measurements = await measure();
      await fs.writeFile(
        path.join(proof, engine + "-expanded.json"),
        JSON.stringify(measurements, null, 2),
      );
      const screenshot = await takeControlUiScreenshotFrame(
        page,
        host,
        [host.locator(".exit-fullscreen")],
        { elements: [host], animations: "disabled" },
      );
      await fs.writeFile(path.join(proof, engine + "-expanded.png"), screenshot.png);
      expect(measurements.iframe).toBeGreaterThan(700);
      expect(measurements.iframe).toBeLessThanOrEqual(measurements.viewport);
      await page.setViewportSize({ width: 820, height: 650 });
      await expect
        .poll(async () => {
          const resized = await measure();
          return (
            resized.iframe > 550 &&
            resized.iframe <= resized.viewport &&
            resized.iframe < measurements.iframe
          );
        })
        .toBe(true);
      await host.getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => host.getAttribute("display-mode")).toBe("inline");
      await expect.poll(() => outer.evaluate((e) => e.getBoundingClientRect().height)).toBe(450);
    } finally {
      await context.close();
      await browser.close();
    }
  },
  120_000,
);
