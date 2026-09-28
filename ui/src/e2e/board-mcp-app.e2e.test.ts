// Dashboard MCP App E2E covers the real Control UI, sandbox proxy, and mocked Gateway lease flow.
import { writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps/app-bridge";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { getGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.e2e.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { focusChatSidePanel, restoreChatAsMain } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const sessionKey = "agent:main:board-mcp-app";
const rosterMatch = { includeGlobal: true };

let browser: Browser;
let controlUi: ControlUiE2eServer;
let sandboxServer: HttpServer;
let sandboxPort: number;
const contexts = new Set<BrowserContext>();

function widget(index: number) {
  return {
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
  } as const;
}

function boardSnapshot(count: number, revision = 1) {
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: Array.from({ length: count }, (_, index) => widget(index)),
  };
}

async function openDashboard(page: Page): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(controlUi.baseUrl);
  await page.addInitScript(
    ({ key, storageKey }) => {
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = { [key]: { activeTabId: "main" } };
      localStorage.setItem(storageKey, JSON.stringify(settings));
    },
    { key: sessionKey, storageKey: settingsKey },
  );
  await page.goto(controlUiSessionUrl(controlUi.baseUrl, sessionKey, "dashboard"));
  await page.locator(".board-session-surface").waitFor();
}

function appViewPayload() {
  return {
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort,
    html: '<!doctype html><output>Dashboard app</output><label>Draft note <input aria-label="Draft note"></label>',
    toolInput: {},
    toolResult: { content: [{ type: "text", text: "ready" }] },
    messageSupported: false,
    updateModelContextSupported: false,
  };
}

async function waitForMountedApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(document.querySelector("mcp-app-view")?.shadowRoot?.querySelector("iframe")),
    undefined,
    { timeout: 15_000 },
  );
}

async function cycleBoardProviderConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector(".board-session-surface");
    const pane = surface?.closest("openclaw-chat-pane");
    const lease = pane ? Reflect.get(pane, "boardProviderLease") : undefined;
    const scopedProvider = lease?.provider;
    const transport = scopedProvider ? Reflect.get(scopedProvider, "transport") : undefined;
    const client = transport ? Reflect.get(transport, "client") : undefined;
    if (!transport || !client || typeof transport.attachClient !== "function") {
      throw new Error("Dashboard Gateway provider is unavailable");
    }
    transport.attachClient(client, false);
    transport.attachClient(client, true);
  });
}

async function captureBoardIdentity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".board-session-surface");
    const board = surface?.querySelector("openclaw-board-view");
    const cell = board?.querySelector("openclaw-board-widget-cell");
    const appView = cell?.querySelector("mcp-app-view");
    const iframe = appView?.shadowRoot?.querySelector("iframe");
    if (!surface || !board || !cell || !appView || !iframe) {
      throw new Error("Board MCP App identity is incomplete");
    }
    Reflect.set(window, "__openclawBoardIdentity", { surface, board, cell, appView, iframe });
  });
}

async function readBoardIdentity(page: Page) {
  return await page.evaluate(() => {
    const stored = Reflect.get(window, "__openclawBoardIdentity") as {
      surface: HTMLElement;
      board: Element;
      cell: Element;
      appView: Element;
      iframe: Element;
    };
    const surface = document.querySelector<HTMLElement>(".board-session-surface");
    const board = surface?.querySelector("openclaw-board-view");
    const cell = board?.querySelector("openclaw-board-widget-cell");
    const appView = cell?.querySelector("mcp-app-view");
    const iframe = appView?.shadowRoot?.querySelector("iframe");
    return {
      connected: [stored.surface, stored.board, stored.cell, stored.appView, stored.iframe].every(
        (element) => element.isConnected,
      ),
      hidden: surface?.hidden ?? null,
      inert: surface?.inert ?? null,
      same:
        surface === stored.surface &&
        board === stored.board &&
        cell === stored.cell &&
        appView === stored.appView &&
        iframe === stored.iframe,
    };
  });
}

async function expectRetainedBoardPresentation(
  page: Page,
  presentation: "split" | "expanded",
): Promise<void> {
  await expect
    .poll(() => readBoardIdentity(page))
    .toEqual({ connected: true, hidden: false, inert: false, same: true });
  await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);
  await expect
    .poll(() => page.locator(".sidebar-region__right-runtime .side-panel").count())
    .toBe(1);
  await expect
    .poll(() => page.locator(".sidebar-region--expanded").count())
    .toBe(presentation === "expanded" ? 1 : 0);
  await expect
    .poll(() => page.locator(".chat-thread").isVisible())
    .toBe(presentation !== "expanded");
}

describeControlUiE2e("Control UI dashboard MCP Apps", () => {
  beforeAll(async () => {
    controlUi = await startControlUiE2eServer();
    sandboxPort = await getGatewayE2ePortBlock();
    sandboxServer = createSandboxHostHttpServer();
    await new Promise<void>((resolve) => {
      sandboxServer.listen(sandboxPort, "127.0.0.1", resolve);
    });

    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    for (const context of contexts) {
      await context.close();
    }
    await browser?.close();
    if (sandboxServer) {
      await new Promise<void>((resolve) => {
        sandboxServer.close(() => resolve());
      });
    }
    await controlUi?.close();
  });

  it("renders a pinned app and proactively renews its board lease", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      permissions: ["local-network-access"],
    });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "mcp.app.view",
      ],
      methodResponses: {
        "board.get": boardSnapshot(1),
        "board.widget.appView": {
          sequence: [
            { viewId: "short-view", expiresAtMs: Date.now() + 7_000 },
            { viewId: "renewed-view", expiresAtMs: Date.now() + 3_600_000 },
          ],
        },
        "mcp.app.view": appViewPayload(),
      },
    });

    await openDashboard(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 15_000,
      })
      .toBe(2);
    // Renewal replaces the iframe. The new-binding request follows teardown,
    // so wait for it before sampling the replacement's rendered background.
    await expect
      .poll(async () =>
        (await gateway.getRequests("mcp.app.view")).map((request) => request.params),
      )
      .toContainEqual({ sessionKey, viewId: "renewed-view" });
    await waitForMountedApp(page);
    const widgetBackgrounds = await page.evaluate(() => {
      const widgetElement = document.querySelector<HTMLElement>('[data-test-id="board-widget"]');
      const frame = document
        .querySelector("mcp-app-view")
        ?.shadowRoot?.querySelector<HTMLIFrameElement>("iframe");
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
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["board.widget.appView"],
      sessionKey,
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "mcp.app.view",
      ],
      methodResponses: {
        "board.get": boardSnapshot(1),
        "board.widget.appView": {
          viewId: "current-view",
          expiresAtMs: Date.now() + 3_600_000,
        },
        "mcp.app.view": appViewPayload(),
      },
    });

    await openDashboard(page);
    await gateway.waitForRequest("board.widget.appView");
    await gateway.deferNext("board.widget.appView");
    const boardGetCount = (await gateway.getRequests("board.get")).length;
    await cycleBoardProviderConnection(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length)
      .toBeGreaterThan(boardGetCount);

    await gateway.resolveDeferred("board.widget.appView", {
      viewId: "retired-view",
      expiresAtMs: Date.now() + 3_600_000,
    });
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
    await gateway.resolveDeferred("board.widget.appView", {
      viewId: "current-view",
      expiresAtMs: Date.now() + 3_600_000,
    });
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
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("board-panel-retention", artifactRoot)
      : undefined;
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
      ...(artifactDir ? { recordVideo: { dir: artifactDir } } : {}),
    });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "mcp.app.view",
        "sessions.patch",
      ],
      methodResponses: {
        "board.get": boardSnapshot(1),
        "board.widget.appView": {
          viewId: "retained-view",
          expiresAtMs: Date.now() + 3_600_000,
        },
        "mcp.app.view": {
          ...appViewPayload(),
          html: `<!doctype html><style>
            body{margin:0;min-height:100vh;box-sizing:border-box;padding:28px;background:#11222d;color:#dbefed;font:16px system-ui}
            h1{font-size:36px;margin:8px 0 24px}.metrics{display:flex;gap:16px;margin:24px 0}
            .metric{flex:1;padding:24px;background:#193746;border:1px solid #38616b;border-radius:12px}
            strong{display:block;font-size:32px;margin-top:8px}input{display:block;margin-top:8px;padding:12px;border-radius:8px}
          </style><output>Dashboard app</output><h1>Release overview</h1>
          <p>A synthetic dashboard for fullscreen layout verification.</p>
          <div class="metrics"><div class="metric">Checks passed<strong>24 / 24</strong></div>
          <div class="metric">Median duration<strong>12m 40s</strong></div></div>
          <label>Draft note <input aria-label="Draft note"></label>
          <script>
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
          </script>`,
        },
      },
    });

    await openDashboard(page);
    await waitForMountedApp(page);
    await captureBoardIdentity(page);
    const stableCounts = {
      boardGet: (await gateway.getRequests("board.get")).length,
      appView: (await gateway.getRequests("board.widget.appView")).length,
      mcpView: (await gateway.getRequests("mcp.app.view")).length,
    };
    const stablePatchCount = (await gateway.getRequests("sessions.patch")).length;
    const stableListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    const sidePanel = page.locator(".sidebar-region__right-runtime .side-panel");
    const appContent = page
      .frameLocator("mcp-app-view iframe")
      .frameLocator("iframe")
      .getByText("Dashboard app", { exact: true });
    await expectRetainedBoardPresentation(page, "split");
    if (artifactDir) {
      await appContent.waitFor();
      await writeFile(
        `${artifactDir}/01-dashboard.png`,
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [appContent]),
      );
    }

    await focusChatSidePanel(page);
    await expectRetainedBoardPresentation(page, "expanded");
    const frameInsets = () =>
      page.evaluate(() => {
        const board = document.querySelector("openclaw-board-view");
        const body = board?.querySelector(".board-widget__body");
        const frame = board?.querySelector("mcp-app-view")?.shadowRoot?.querySelector("iframe");
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
    if (artifactDir) {
      await appContent.waitFor();
      await page.screenshot({ path: `${artifactDir}/fullscreen-dashboard.png` });
    }
    const expectHostDimensions = async () => {
      const frame = page.locator("mcp-app-view iframe");
      const dimensions = await frame.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      await expect
        .poll(async () =>
          JSON.parse(
            (await page
              .frameLocator("mcp-app-view iframe")
              .frameLocator("iframe")
              .locator("html")
              .getAttribute("data-host-dimensions")) ?? "null",
          ),
        )
        .toEqual(dimensions);
    };
    expect(await frameInsets()).toEqual({ top: 0, bottom: 0, bodyHeightGap: 0 });
    await expectHostDimensions();
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(await frameInsets()).toEqual({ top: 0, bottom: 0, bodyHeightGap: 0 });
    await expectHostDimensions();
    await expectRetainedBoardPresentation(page, "expanded");
    if (artifactDir) {
      await page.screenshot({ path: `${artifactDir}/fullscreen-dashboard-resized.png` });
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await page
      .locator(".chat-pane__header")
      .getByRole("button", { name: "Restore split", exact: true })
      .click();
    await expectRetainedBoardPresentation(page, "split");
    expect((await frameInsets()).bodyHeightGap).toBe(0);
    await expectHostDimensions();
    await restoreChatAsMain(page);

    const draftNote = page
      .frameLocator("mcp-app-view iframe")
      .frameLocator("iframe")
      .getByRole("textbox", { name: "Draft note" });
    await draftNote.fill("Keep this unsaved dashboard note");
    if (artifactDir) {
      await page.screenshot({ path: `${artifactDir}/04-note-before-minimize.png` });
    }
    await sidePanel
      .locator('[data-region-header="side"]')
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.locator(".chat-thread").waitFor();
    await expect
      .poll(() => readBoardIdentity(page))
      .toEqual({
        connected: true,
        hidden: true,
        inert: true,
        same: true,
      });
    await page.locator(".chat-side-panel-toggle").click();
    await draftNote.waitFor();
    if (artifactDir) {
      await page.screenshot({ path: `${artifactDir}/05-note-after-reopen.png` });
    }
    await expect.poll(() => draftNote.inputValue()).toBe("Keep this unsaved dashboard note");
    await expectRetainedBoardPresentation(page, "split");

    const typeMenu = sidePanel.locator("wa-dropdown.side-panel-type-menu");
    await typeMenu.getByRole("button", { name: "Add side panel tab" }).click();
    await typeMenu.locator("wa-dropdown-item").filter({ hasText: "Files" }).click();
    await expect
      .poll(() => typeMenu.evaluate((element) => Reflect.get(element, "open")))
      .toBe(false);
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
    const inactiveIdentity = await readBoardIdentity(page);
    if (artifactDir) {
      await writeFile(
        `${artifactDir}/02-files.png`,
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          sidePanel.getByRole("tab", { name: "Files", exact: true }),
        ]),
      );
    }

    await sidePanel.getByRole("tab", { name: "Dashboard", exact: true }).click();
    await expectRetainedBoardPresentation(page, "expanded");
    await expect.poll(() => draftNote.inputValue()).toBe("Keep this unsaved dashboard note");
    await sidePanel
      .locator('[data-region-header="side"]')
      .getByRole("button", { name: "Restore split", exact: true })
      .click();
    await expectRetainedBoardPresentation(page, "split");
    await expect.poll(() => draftNote.inputValue()).toBe("Keep this unsaved dashboard note");
    if (artifactDir) {
      await appContent.waitFor();
      await writeFile(
        `${artifactDir}/03-dashboard-restored.png`,
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [appContent]),
      );
    }
    expect(inactiveIdentity).toEqual({ connected: true, hidden: true, inert: true, same: true });
    await expectRetainedBoardPresentation(page, "split");
    expect(await gateway.getRequests("board.update")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.patch")).toHaveLength(stablePatchCount);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(stableListCount);
    expect(await gateway.getRequests("board.get")).toHaveLength(stableCounts.boardGet);
    expect(await gateway.getRequests("board.widget.appView")).toHaveLength(stableCounts.appView);
    expect(await gateway.getRequests("mcp.app.view")).toHaveLength(stableCounts.mcpView);
  });

  it("does not eagerly mint leases for all 48 offscreen cells", async () => {
    const context = await browser.newContext({
      permissions: ["local-network-access"],
      viewport: { width: 1280, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "chat.history",
        "chat.metadata",
        "chat.startup",
        "mcp.app.view",
      ],
      methodResponses: {
        "board.get": boardSnapshot(48),
        "board.widget.appView": { viewId: "shared-view", expiresAtMs: Date.now() + 3_600_000 },
        "mcp.app.view": appViewPayload(),
      },
    });

    await openDashboard(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.widget.appView")).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await waitForMountedApp(page);
    await page.waitForTimeout(500);
    const requests = await gateway.getRequests("board.widget.appView");
    expect(requests.length).toBeLessThan(48);
  });
});
