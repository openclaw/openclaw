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
import {
  focusChatSidePanel,
  openChatSidePanelType,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";

const sessionKey = "agent:main:board-mcp-app";
const rosterMatch = { includeGlobal: true };
type BoardIdentity = [HTMLElement, Element, Element, Element, Element];

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
    count = 1,
    app = appViewPayload(),
    ...scenario
  }: ControlUiMockGatewayScenario & {
    count?: number;
    app?: ReturnType<typeof appViewPayload>;
  } = {},
) {
  return installMockGateway(page, {
    sessionKey,
    featureMethods: appMethods,
    ...scenario,
    methodResponses: {
      "board.get": boardSnapshot(count),
      "board.widget.appView": view,
      "mcp.app.view": app,
    },
  });
}

const appFrame = (page: Page) => page.frameLocator("mcp-app-view iframe").frameLocator("iframe");
const draftNote = (page: Page) => appFrame(page).getByRole("textbox", { name: "Draft note" });

function boardSnapshot(count: number, revision = 1) {
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: Array.from(
      { length: count },
      (_, index) =>
        ({
          name: `app-${index}`,
          tabId: "main",
          title: `App ${index}`,
          contentKind: "mcp-app",
          sizeW: 12,
          sizeH: 3,
          position: index,
          grantState: "none",
          revision: 1,
          instanceId: `instance-${index}`,
        }) as const,
    ),
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

async function cycleBoardProviderConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector(".board-session-surface");
    const pane = surface?.closest("openclaw-chat-pane");
    const lease = pane ? Reflect.get(pane, "boardProviderLease") : undefined;
    const context = pane ? Reflect.get(pane, "context") : undefined;
    const client = context?.gateway.snapshot.client;
    const provider = lease?.provider;
    if (!lease || !provider || !client) {
      throw new Error("Dashboard Gateway provider is unavailable");
    }
    const capabilities = {
      canPinWidgets: provider.canPinWidgets,
      canPinMcpApps: provider.canPinMcpApps,
      canMutate: provider.canMutate,
      canGrant: provider.canGrant,
    };
    lease.update(client, false, capabilities);
    lease.update(client, true, capabilities);
  });
}

async function readBoardIdentity(page: Page, capture = false) {
  return await page.evaluate((shouldCapture) => {
    const storageKey = "__openclawBoardIdentity";
    const surface = document.querySelector<HTMLElement>(".board-session-surface");
    const board = surface?.querySelector("openclaw-board-view");
    const cell = board?.querySelector("openclaw-board-widget-cell");
    const appView = cell?.querySelector("mcp-app-view");
    const iframe = appView?.querySelector("iframe");
    const current = [surface, board, cell, appView, iframe];
    if (shouldCapture) {
      if (!surface || !board || !cell || !appView || !iframe) {
        throw new Error("Board MCP App identity is incomplete");
      }
      Reflect.set(window, storageKey, current);
    }
    const stored = Reflect.get(window, storageKey) as BoardIdentity;
    return {
      connected: stored.every((element) => element.isConnected),
      hidden: surface?.hidden ?? null,
      inert: surface?.inert ?? null,
      same: current.every((element, index) => element === stored[index]),
    };
  }, capture);
}

async function expectRetainedBoardPresentation(
  page: Page,
  presentation: "split" | "expanded",
): Promise<void> {
  await expect
    .poll(() => readBoardIdentity(page))
    .toEqual({ connected: true, hidden: false, inert: false, same: true });
  await expect
    .poll(async () => ({
      boardVisible: await page.locator(".board-session-surface").isVisible(),
      panels: await page.locator(".sidebar-region__right-runtime .side-panel").count(),
      expanded: await page.locator(".sidebar-region--expanded").count(),
      chatVisible: await page.locator(".chat-thread").isVisible(),
    }))
    .toEqual({
      boardVisible: true,
      panels: 1,
      expanded: presentation === "expanded" ? 1 : 0,
      chatVisible: presentation !== "expanded",
    });
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

  it("renders a pinned app and proactively renews its board lease", async () => {
    const page = await newPage({ colorScheme: "dark" });
    const gateway = await installApp(page, {
      sequence: [appLease("short-view", 7_000), appLease("renewed-view")],
    });

    await suite.openDashboard(page, sessionKey);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 15_000,
      })
      .toBe(2);
    // Wait for the renewed binding before reading its replacement iframe's background.
    await expect
      .poll(async () =>
        (await gateway.getRequests("mcp.app.view")).map((request) => request.params),
      )
      .toContainEqual({ sessionKey, viewId: "renewed-view" });
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
    expect((await gateway.getRequests("board.widget.appView"))[0]?.params).toEqual({
      sessionKey,
      agentId: "main",
      name: "app-0",
      revision: 1,
      instanceId: "instance-0",
    });
  });

  it("drops a pending app view across reconnect and mounts the current lease", async () => {
    const page = await newPage({ viewport: { width: 1280, height: 800 } });
    const gateway = await installApp(page, appLease("current-view"), {
      deferredMethods: ["board.widget.appView"],
    });

    await suite.openDashboard(page, sessionKey);
    await gateway.waitForRequest("board.widget.appView");
    await gateway.deferNext("board.widget.appView");
    const boardGetCount = (await gateway.getRequests("board.get")).length;
    await cycleBoardProviderConnection(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length)
      .toBeGreaterThan(boardGetCount);

    await gateway.resolveDeferred("board.widget.appView", appLease("retired-view"));
    await page.evaluate(
      async () =>
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await gateway.getRequests("mcp.app.view")).toEqual([]);

    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length)
      .toBe(2);
    await gateway.resolveDeferred("board.widget.appView", appLease("current-view"));
    await waitForMountedApp(page);
    await expect
      .poll(async () =>
        (await gateway.getRequests("mcp.app.view")).map((request) => request.params),
      )
      .toContainEqual({
        sessionKey,
        viewId: "current-view",
      });
    expect(await gateway.getRequests("mcp.app.view")).not.toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ viewId: "retired-view" }),
      }),
    );
  });

  it("retains one board runtime across split, expanded, and inactive panel states", async () => {
    const page = await newPage({ viewport: { width: 1280, height: 800 } });
    const gateway = await installApp(page, appLease("retained-view"), {
      featureMethods: [...appMethods, "sessions.patch"],
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
    await readBoardIdentity(page, true);
    const requestCounts = async () => ({
      boardGet: (await gateway.getRequests("board.get")).length,
      appView: (await gateway.getRequests("board.widget.appView")).length,
      mcpView: (await gateway.getRequests("mcp.app.view")).length,
      patches: (await gateway.getRequests("sessions.patch")).length,
      lists: (await gateway.getRequests("sessions.list", rosterMatch)).length,
    });
    const stableCounts = await requestCounts();
    const sidePanel = page.locator(".sidebar-region__right-runtime .side-panel");
    await expectRetainedBoardPresentation(page, "split");

    await focusChatSidePanel(page);
    await expectRetainedBoardPresentation(page, "expanded");
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
    await expectRetainedBoardPresentation(page, "expanded");
    await page.setViewportSize({ width: 1280, height: 800 });

    await selectChatLayoutAction(page, "Restore split");
    await expectRetainedBoardPresentation(page, "split");
    await expect.poll(async () => (await frameInsets()).bodyHeightGap).toBe(0);
    await expectHostDimensions();
    await restoreChatAsMain(page);

    const note = draftNote(page);
    await note.fill("Keep this unsaved dashboard note");
    await selectChatLayoutAction(page, "Minimize side panel");
    await page.locator(".chat-thread").waitFor();
    await expect
      .poll(() => readBoardIdentity(page))
      .toEqual({ connected: true, hidden: true, inert: true, same: true });
    await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
    await note.waitFor();
    await expect.poll(() => note.inputValue()).toBe("Keep this unsaved dashboard note");
    await expectRetainedBoardPresentation(page, "split");

    await openChatSidePanelType(page, "Files");
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
    const inactiveIdentity = await readBoardIdentity(page);

    await sidePanel.getByRole("tab", { name: "Dashboard", exact: true }).click();
    await expectRetainedBoardPresentation(page, "expanded");
    await expect.poll(() => note.inputValue()).toBe("Keep this unsaved dashboard note");
    await selectChatLayoutAction(page, "Restore split");
    await expectRetainedBoardPresentation(page, "split");
    await expect.poll(() => note.inputValue()).toBe("Keep this unsaved dashboard note");
    expect(inactiveIdentity).toEqual({ connected: true, hidden: true, inert: true, same: true });
    await expectRetainedBoardPresentation(page, "split");
    expect(await gateway.getRequests("board.update")).toHaveLength(0);
    expect(await requestCounts()).toEqual(stableCounts);
  });

  it("does not eagerly mint leases for all 48 offscreen cells", async () => {
    const page = await newPage({ viewport: { width: 1280, height: 800 } });
    const gateway = await installApp(page, appLease("shared-view"), { count: 48 });

    await suite.openDashboard(page, sessionKey);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await page
      .locator("mcp-app-view iframe")
      .first()
      .waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForTimeout(500);
    const requests = await gateway.getRequests("board.widget.appView");
    expect(requests.length).toBeLessThan(48);
  });
});
