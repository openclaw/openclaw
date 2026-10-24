import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createBoardE2eSuite } from "./board-browser.test-support.ts";
import { focusChatSidePanel } from "./chat-side-panel.test-support.ts";

const sessionKey = "agent:main:board-mcp-app";

const suite = createBoardE2eSuite("Control UI dashboard MCP Apps");
const appMethods = [
  "board.get",
  "board.widget.appView",
  "chat.history",
  "chat.metadata",
  "chat.startup",
  "mcp.app.view",
];

function newPage(options: Parameters<typeof suite.newPage>[0] = {}) {
  return suite.newPage({ permissions: ["local-network-access"], ...options });
}

function appLease(viewId: string, ttlMs = 3_600_000) {
  return { viewId, expiresAtMs: Date.now() + ttlMs };
}

function installApp(
  page: Page,
  view: unknown,
  {
    app = appViewPayload(),
    ...scenario
  }: ControlUiMockGatewayScenario & {
    app?: ReturnType<typeof appViewPayload>;
  } = {},
) {
  return installMockGateway(page, {
    sessionKey,
    featureMethods: appMethods,
    ...scenario,
    methodResponses: {
      "board.get": boardSnapshot(),
      "board.widget.appView": view,
      "mcp.app.view": app,
    },
  });
}

const appFrame = (page: Page) => page.frameLocator("mcp-app-view iframe").frameLocator("iframe");
const draftNote = (page: Page) => appFrame(page).getByRole("textbox", { name: "Draft note" });

function boardSnapshot() {
  return {
    sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "app-0",
        tabId: "main",
        title: "App 0",
        contentKind: "mcp-app",
        sizeW: 12,
        sizeH: 3,
        position: 0,
        grantState: "none",
        revision: 1,
        instanceId: "instance-0",
      } as const,
    ],
  };
}

function appViewPayload(extraHtml = "") {
  return {
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: suite.sandboxPort,
    html: `<!doctype html><output>Dashboard app</output><label>Draft note <input aria-label="Draft note"></label>${extraHtml}`,
    toolInput: {},
    toolResult: { content: [{ type: "text", text: "ready" }] },
    messageSupported: false,
    updateModelContextSupported: false,
  };
}

async function waitForMountedApp(page: Page): Promise<void> {
  await page.locator("mcp-app-view iframe").waitFor({ state: "attached", timeout: 15_000 });
}

suite.define(() => {
  it("closes Inbox when a dashboard frame receives an outside click without stealing focus", async () => {
    const page = await newPage();
    await installApp(page, appLease("inbox-focus-view"), {
      featureMethods: ["board.get", "board.widget.appView", "mcp.app.view"],
    });
    await suite.openDashboard(page, sessionKey);
    const note = draftNote(page);
    await note.waitFor();
    const trigger = page.locator(".sidebar-issues-button:visible");
    const panel = page.locator("#sidebar-issues-panel");
    await trigger.click();
    await panel.waitFor();
    await clickBoardWidgetControl(page, note);
    await panel.waitFor({ state: "hidden" });
    // Type through actual keyboard focus, not fill(), which would refocus the input.
    await page.keyboard.type("Keep this dashboard draft");
    expect(await note.inputValue()).toBe("Keep this dashboard draft");
    await page.keyboard.press("Escape");
    expect(await panel.count()).toBe(0);

    await trigger.click();
    await panel.waitFor();
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await note.inputValue()).toBe("Keep this dashboard draft");
  });

  it("fills the dashboard and reports its actual frame dimensions through expansion and resize", async () => {
    const page = await newPage({ viewport: { width: 1280, height: 800 } });
    await installApp(page, appLease("retained-view"), {
      app: appViewPayload(`<style>body{margin:0;min-height:100vh}</style><script>
            const send = (message) => parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
            const dimensions = (context) => {
              if (context?.containerDimensions) {
                document.documentElement.dataset.hostDimensions = JSON.stringify(context.containerDimensions);
              }
            };
            addEventListener("message", ({ source, data }) => {
              if (source !== parent) return;
              if (data.id === 1 && data.result) {
                dimensions(data.result.hostContext);
                send({ method: "ui/notifications/initialized" });
              } else if (data.method === "ui/notifications/host-context-changed") {
                dimensions(data.params);
              } else if (data.method === "ui/resource-teardown") {
                send({ id: data.id, result: {} });
              }
            });
            send({ id: 1, method: "ui/initialize", params: {
              appInfo: { name: "Dashboard fixture", version: "1.0.0" }, appCapabilities: {},
              protocolVersion: ${JSON.stringify(LATEST_PROTOCOL_VERSION)}
            } });
          </script>`),
    });

    await suite.openDashboard(page, sessionKey);
    await waitForMountedApp(page);
    const widgetBackgrounds = await page.evaluate(() => {
      const widgetElement = document.querySelector<HTMLElement>('[data-test-id="board-widget"]');
      const frame = document.querySelector<HTMLIFrameElement>("mcp-app-view iframe");
      if (!widgetElement || !frame) {
        throw new Error("dashboard MCP App frame is missing");
      }
      return {
        frame: getComputedStyle(frame).backgroundColor,
        widget: getComputedStyle(widgetElement).backgroundColor,
      };
    });
    expect(widgetBackgrounds.frame).toBe(widgetBackgrounds.widget);
    expect(widgetBackgrounds.frame).not.toBe("rgba(0, 0, 0, 0)");
    await focusChatSidePanel(page);
    const frameInsets = () =>
      page.evaluate(() => {
        const board = document.querySelector("openclaw-board-view");
        const body = board?.querySelector(".board-widget__body");
        const frame = board?.querySelector("mcp-app-view")?.querySelector("iframe");
        if (!board || !body || !frame) {
          throw new Error("Dashboard MCP App layout is unavailable");
        }
        const outer = board.getBoundingClientRect();
        const available = body.getBoundingClientRect();
        const inner = frame.getBoundingClientRect();
        return {
          top: Math.round(inner.top - outer.top),
          bottom: Math.round(outer.bottom - inner.bottom),
          bodyHeightGap: Math.round(available.height - inner.height),
        };
      });
    // Measure the frame on every poll: a viewport resize settles the board
    // layout asynchronously, so a size read before polling can be stale.
    const expectHostDimensions = async () => {
      const frame = page.locator("mcp-app-view iframe");
      await expect
        .poll(async () => {
          const size = await frame.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { width: Math.round(rect.width), height: Math.round(rect.height) };
          });
          const reported = JSON.parse(
            (await appFrame(page).locator("html").getAttribute("data-host-dimensions")) ?? "null",
          ) as { width?: number; height?: number } | null;
          return reported?.width === size.width && reported?.height === size.height;
        })
        .toBe(true);
    };
    await expect.poll(frameInsets).toEqual({ top: 0, bottom: 0, bodyHeightGap: 0 });
    await expectHostDimensions();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(frameInsets).toEqual({ top: 0, bottom: 0, bodyHeightGap: 0 });
    await expectHostDimensions();
    await page.setViewportSize({ width: 1280, height: 800 });

    await selectChatLayoutAction(page, "Restore split");
    await expect.poll(async () => (await frameInsets()).bodyHeightGap).toBe(0);
    await expectHostDimensions();
  });
});
