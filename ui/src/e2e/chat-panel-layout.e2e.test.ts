import type { Server as HttpServer } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { buildBoardWidgetSandboxPath } from "../../../src/gateway/board-sandbox.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { openChatPanels, selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiSessionUrl,
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { dockChatSidePanel, openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat panel layout",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:chat-panel-layout";
const chatMethods = ["board.get", "chat.metadata", "chat.startup"];
let sandbox: HttpServer;
let sandboxPort: number;

async function regionSize(region: Locator, dimension: "width" | "height" = "width") {
  return region.evaluate((element, axis) => element.getBoundingClientRect()[axis], dimension);
}

function widgetInput(page: Page): Locator {
  return page.frameLocator(".board-widget__frame").frameLocator("iframe").locator("#widget-note");
}

function documentIdentity(input: Locator) {
  return input.evaluate((element) =>
    Reflect.get(element.ownerDocument.defaultView!, "documentIdentity"),
  );
}

async function installBoardGateway(
  page: Page,
  scenario: NonNullable<Parameters<typeof installMockGateway>[1]>,
  widgetHeight = 6,
) {
  const body = buildWidgetDocument(
    "Dashboard",
    '<label>Widget note <input id="widget-note"></label><script>globalThis.documentIdentity=crypto.randomUUID();</script>',
  );
  await page.route("**/__openclaw__/board/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body }),
  );
  return installMockGateway(page, {
    sessionKey,
    historyMessages: [{ role: "assistant", content: "The release overview is ready." }],
    ...scenario,
    methodResponses: { "board.get": boardResponse(widgetHeight), ...scenario.methodResponses },
  });
}

function boardResponse(sizeH: number) {
  return {
    sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0 }],
    widgets: [
      {
        name: "continuity",
        tabId: "main",
        title: "Dashboard",
        contentKind: "html",
        sizeW: 12,
        sizeH,
        heightMode: "fixed",
        position: 0,
        grantState: "none",
        revision: 1,
        instanceId: "continuity-instance",
        frameUrl: `${new URL(suite.server.baseUrl).origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/continuity/index.html?bt=ticket`,
        viewTicket: "ticket",
        viewTicketTtlMs: 1_200_000,
        viewGeneration: "0123456789abcdef0123456789abcdef",
        sandboxUrl: buildBoardWidgetSandboxPath({ grantState: "none" }),
        sandboxPort,
      },
    ],
  };
}

async function layoutAndWait(
  owner: Page | Locator,
  action: string | RegExp,
  visible: Locator,
  hidden?: Locator,
) {
  await selectChatLayoutAction(owner, action);
  await visible.waitFor();
  await hidden?.waitFor({ state: "hidden" });
}

async function waitForPanelGeometry(page: Page): Promise<void> {
  await page.locator(".sidebar-region").evaluate(async (element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function expectSideConversationFits(page: Page) {
  const chat = page.locator('.sidebar-region__primary[data-region="side"]');
  await expect
    .poll(() =>
      chat.evaluate((element) => {
        const panel = element.getBoundingClientRect();
        return [".chat-main__conversation", ".chat-thread", ".agent-chat__composer-shell"].every(
          (selector) => {
            const content = element.querySelector(selector)!.getBoundingClientRect();
            return (
              content.width > 0 &&
              content.left >= panel.left - 1 &&
              content.right <= panel.right + 1
            );
          },
        );
      }),
    )
    .toBe(true);
}

async function expectPaneHeaderGeometry(page: Page, dock: "left" | "right" | "bottom") {
  await waitForPanelGeometry(page);
  const boxes = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing visible pane surface: ${selector}`);
      }
      const { x, y, width, height, bottom, right } = element.getBoundingClientRect();
      return { x, y, width, height, bottom, right };
    };
    return {
      toolbarFrame: bounds(".sidebar-region__header"),
      toolbar: bounds(".chat-pane__header"),
      tabs: bounds('[data-region-header="side"]'),
      toggle: bounds(".chat-pane__panels-toggle"),
      tabControlCenters: Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-region-header="side"] button:not(.oc-overlay button)',
        ),
      )
        .map((button) => button.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .map((box) => box.y + box.height / 2),
      main: bounds('.sidebar-region [data-region="main"]:not([hidden])'),
      side: bounds('.sidebar-region [data-region="side"]:not([hidden])'),
    };
  });
  // The session topbar and side tabs share the compact desktop header height.
  expect(boxes.toolbar.height).toBe(44);
  expect(boxes.toolbarFrame.height).toBe(44);
  expect(boxes.tabs.height).toBe(44);
  expect(boxes.toggle.y + boxes.toggle.height / 2).toBe(boxes.toolbar.y + boxes.toolbar.height / 2);
  for (const center of boxes.tabControlCenters) {
    expect(center).toBe(boxes.tabs.y + boxes.tabs.height / 2);
  }
  // Left/bottom docking reserves the 28px Panels toggle plus its 4px gap in the frame.
  expect(boxes.toolbar.x).toBe(boxes.toolbarFrame.x);
  expect(boxes.toolbar.y).toBe(boxes.toolbarFrame.y);
  expect(boxes.toolbarFrame.right - boxes.toolbar.right).toBe(dock === "right" ? 0 : 32);
  for (const [header, content] of [
    [boxes.toolbarFrame, boxes.main],
    [boxes.tabs, boxes.side],
  ] as const) {
    expect(header.height).toBeGreaterThan(0);
    expect(content.height).toBeGreaterThan(80);
    expect(header.x).toBeCloseTo(content.x, 0);
    expect(header.right).toBeCloseTo(content.right, 0);
    expect(header.bottom).toBeCloseTo(content.y, 0);
  }
  if (dock === "bottom") {
    expect(boxes.tabs.y).toBeGreaterThanOrEqual(boxes.main.bottom);
  } else {
    expect(boxes.toolbar.y).toBeCloseTo(boxes.tabs.y, 0);
    expect(boxes.side.y).toBe(boxes.main.y);
    expect(boxes.side.x < boxes.main.x).toBe(dock === "left");
  }
}

suite.define(() => {
  it("opens this dashboard's chat and details independently without losing either draft", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 960 }, permissions: ["local-network-access"] },
      async ({ page }) => {
        const gateway = await installBoardGateway(page, {
          sessions: [
            {
              key: sessionKey,
              sessionId: "page-chat-session",
              kind: "direct",
              boardFace: "dashboard",
              boardPresentation: "expanded",
              updatedAt: Date.now(),
            },
          ],
          featureMethods: [
            ...chatMethods,
            "sessions.list",
            "sessions.describe",
            "sessions.resolve",
          ],
          methodResponses: {
            "cron.list": { jobs: [], total: 0, hasMore: false },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        const input = widgetInput(page);
        await input.fill("Keep the release note while discussing changes");
        const identity = await documentIdentity(input);
        const panels = page
          .locator(".sidebar-region__panels-toggle")
          .getByRole("button", { name: "Panels", exact: true });
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await panels.waitFor();
        expect(await panels.getAttribute("aria-expanded")).toBe("false");
        await expect.poll(() => composer.isVisible()).toBe(false);
        // Details is session context, not a shortcut that reveals the transcript.
        const details = await openChatDetails(page);
        expect(await details.getAttribute("role")).toBe("dialog");
        await expect.poll(() => composer.isVisible()).toBe(false);
        await closeChatDetails(page);
        await panels.click();
        await composer.fill("Let's review the eight remaining changes.");
        await page.getByText("The release overview is ready.", { exact: false }).waitFor();
        expect(await panels.getAttribute("aria-expanded")).toBe("true");
        expect(await input.isVisible()).toBe(true);
        // Allow the card inset, but not a fixed-height row when opening Chat.
        const pageHeight = await regionSize(
          page.locator('[data-region="main"]:not([hidden])'),
          "height",
        );
        expect(await regionSize(page.locator(".board-widget__frame"), "height")).toBeGreaterThan(
          pageHeight - 32,
        );
        await panels.click();
        await composer.waitFor({ state: "hidden" });
        await panels.click();
        await composer.waitFor();
        expect(await composer.inputValue()).toBe("Let's review the eight remaining changes.");
        // The mobile dock keeps the conversation available and retains the saved desktop layout.
        await page.setViewportSize({ width: 390, height: 844 });
        const mobileHeader = page.locator(".agent-chat__header--mobile");
        await mobileHeader.locator(".chat-header-session-menu__trigger").click();
        await page.getByRole("menuitem", { name: "Session dashboard", exact: true }).click();
        const host = page.locator(".chat-mobile-host");
        await input.waitFor();
        expect(await composer.isVisible()).toBe(true);
        await host
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await host.waitFor({ state: "hidden" });
        expect(await composer.inputValue()).toBe("Let's review the eight remaining changes.");
        await page.setViewportSize({ width: 1440, height: 960 });
        await input.waitFor();
        expect(await composer.inputValue()).toBe("Let's review the eight remaining changes.");
        expect(await input.inputValue()).toBe("Keep the release note while discussing changes");
        expect(await documentIdentity(input)).toBe(identity);
        expect(
          (await gateway.getRequests()).some(
            (request) => request.method === "chat.send" || request.method === "sessions.create",
          ),
        ).toBe(false);
      },
    );
  });

  beforeAll(async () => {
    sandbox = createSandboxHostHttpServer();
    await new Promise<void>((resolve) => {
      sandbox.listen(0, "127.0.0.1", resolve);
    });
    const address = sandbox.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard sandbox did not bind");
    }
    sandboxPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      sandbox?.close(() => resolve());
    });
  });

  it("associates split-pane tabs with their own content after swapping Chat and Dashboard", async () => {
    await suite.withPage({ viewport: { width: 2200, height: 1000 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey,
        featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
        methodResponses: { "board.get": { sessionKey, tabs: [], widgets: [], revision: 1 } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      await openChatSidePanelType(page, "Dashboard");
      await selectChatLayoutAction(page, "Open split view");
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      for (const pane of await panes.all()) {
        await pane
          .locator('.side-panel__header .tabstrip-tab[data-tab-value="dashboard"]')
          .waitFor();
      }
      const roots = await panes
        .locator('.sidebar-region__primary, .side-panel__panel[data-panel-slot="dashboard"]')
        .elementHandles();
      expect(roots).toHaveLength(4);
      const targets = () =>
        panes.evaluateAll((elements) =>
          elements.map((pane) => {
            const tab = pane.querySelector(
              '.side-panel__header .tabstrip-tab[aria-selected="true"]',
            )!;
            const target = document.getElementById(tab.getAttribute("aria-controls")!);
            return {
              tabId: tab.id,
              targetId: target?.id,
              withinPane: target?.closest("openclaw-chat-pane") === pane,
              role: target?.getAttribute("role"),
              label: target?.getAttribute("aria-label"),
              hasComposer: Boolean(
                target?.querySelector(".agent-chat__composer-combobox textarea"),
              ),
              dashboardPanel: target?.getAttribute("data-panel-slot") === "dashboard",
            };
          }),
        );
      const expectTargets = (actual: Awaited<ReturnType<typeof targets>>, label: string) => {
        for (const target of actual) {
          expect(target).toMatchObject({
            withinPane: true,
            role: "region",
            label,
            hasComposer: label === "Chat",
            dashboardPanel: label === "Dashboard",
          });
        }
      };
      const swapPanes = async (region: "main" | "side") => {
        for (const pane of await panes.all()) {
          await pane.locator(".agent-chat__composer-combobox textarea").click();
          await selectChatLayoutAction(pane, /^Swap /);
          await pane.locator(`.sidebar-region__primary[data-region="${region}"]`).waitFor();
        }
      };
      const original = await targets();
      expect(await page.getByRole("region", { name: "Side panel", exact: true }).count()).toBe(0);
      expect(new Set(original.map((target) => target.tabId)).size).toBe(2);
      expect(new Set(original.map((target) => target.targetId)).size).toBe(2);
      expectTargets(original, "Dashboard");
      await swapPanes("side");
      const swapped = await targets();
      expect(new Set(swapped.map((target) => target.targetId)).size).toBe(2);
      expectTargets(swapped, "Chat");
      await swapPanes("main");
      expect(await targets()).toEqual(original);
      for (const root of roots) {
        expect(
          await root.evaluate(
            (element) =>
              element instanceof HTMLElement && document.getElementById(element.id) === element,
          ),
        ).toBe(true);
      }
    });
  });

  it("preserves live content and saved geometry across main, dock, focus, and narrow layouts", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        permissions: ["local-network-access"],
      },
      async ({ page }) => {
        const gateway = await installBoardGateway(
          page,
          {
            terminalEnabled: true,
            communityInvite: false,
            featureMethods: [...chatMethods, "terminal.open"],
          },
          4,
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        const input = widgetInput(page);
        await input.fill("Keep this unsaved widget input");
        const identity = await documentIdentity(input);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this chat draft");
        const chat = page.locator(".sidebar-region__primary");
        const dashboard = page.locator('[data-panel-slot="dashboard"]');
        const paneHeader = page.locator(".chat-pane__header");
        const sideHeader = page.locator('[data-region-header="side"]');
        await waitForPanelGeometry(page);
        const width = await regionSize(dashboard);
        const expectContinuity = async () => {
          expect(await documentIdentity(input)).toBe(identity);
          expect(await input.inputValue()).toBe("Keep this unsaved widget input");
          expect(await composer.inputValue()).toBe("Keep this chat draft");
        };
        await expectPaneHeaderGeometry(page, "right");
        // Side focus never swaps or reparents either live view.
        const dashboardTab = sideHeader.locator('.tabstrip-tab[data-tab-value="dashboard"]');
        for (const dock of ["right", "left", "bottom"] as const) {
          await dockChatSidePanel(page, dock);
          await waitForPanelGeometry(page);
          const priorSize = await dashboard.boundingBox();
          await dashboardTab.click();
          expect(await chat.isVisible()).toBe(true);
          await layoutAndWait(paneHeader, "Expand Dashboard", dashboard, chat);
          expect(await sideHeader.isVisible()).toBe(true);
          expect(await dashboard.getAttribute("data-region")).toBe("side");
          await expect
            .poll(() => regionSize(dashboard))
            .toBeCloseTo(await regionSize(page.locator(".sidebar-region")), 0);
          await expectContinuity();
          await layoutAndWait(paneHeader, "Restore split", chat);
          await expect.poll(() => dashboard.boundingBox()).toEqual(priorSize);
          await expectPaneHeaderGeometry(page, dock);
          await expectContinuity();
          await layoutAndWait(paneHeader, "Expand Dashboard", dashboard, chat);
          await dashboardTab.focus();
          await page.keyboard.press("Space");
          expect(await chat.isVisible()).toBe(false);
          await layoutAndWait(paneHeader, "Restore split", chat);
          await expectContinuity();
        }
        await dockChatSidePanel(page, "right");
        await expectPaneHeaderGeometry(page, "right");
        await layoutAndWait(paneHeader, "Expand Dashboard", dashboard, chat);
        await selectChatLayoutAction(paneHeader, "Restore split");
        await layoutAndWait(paneHeader, "Minimize side panel", chat, dashboard);
        await layoutAndWait(paneHeader, /^(Side panel|Minimize side panel)$/, dashboard);
        await expectContinuity();
        await chat.evaluate((element) => {
          const initialWidth = element.getBoundingClientRect().width;
          element.parentElement!.addEventListener("openclaw-sidebar-geometry-commit", (event) => {
            if (element.getBoundingClientRect().width !== initialWidth) {
              element.setAttribute(
                "data-swap-width-invalidated",
                element.getAttribute("data-swap-width-invalidated") ??
                  String((event as CustomEvent).detail.widthChanged),
              );
            }
          });
        });
        await selectChatLayoutAction(paneHeader, /^Swap /);
        await expect.poll(() => dashboard.getAttribute("data-region")).toBe("main");
        await expect.poll(() => regionSize(chat)).toBeCloseTo(width, 0);
        await expectSideConversationFits(page);
        // Layout settles before the frame-batched geometry event is delivered.
        await expect.poll(() => chat.getAttribute("data-swap-width-invalidated")).toBe("true");
        await expectPaneHeaderGeometry(page, "right");
        for (const dock of ["left", "bottom", "right"] as const) {
          await dockChatSidePanel(page, dock);
          await expectPaneHeaderGeometry(page, dock);
          await expectSideConversationFits(page);
          if (dock !== "bottom") {
            expect(await regionSize(chat)).toBeCloseTo(width, 0);
          }
          await selectChatLayoutAction(paneHeader, /^Swap /);
          await expect.poll(() => chat.getAttribute("data-region")).toBe("main");
          await expectPaneHeaderGeometry(page, dock);
          await expectContinuity();
          await selectChatLayoutAction(paneHeader, /^Swap /);
          await expect.poll(() => dashboard.getAttribute("data-region")).toBe("main");
          await expectPaneHeaderGeometry(page, dock);
          await expectContinuity();
          await layoutAndWait(paneHeader, "Focus", dashboard, chat);
          await expectContinuity();
          await layoutAndWait(paneHeader, "Restore split", chat);
          await expectContinuity();
        }
        await dockChatSidePanel(page, "left");
        const divider = page.getByRole("separator", { name: "Resize side panel" });
        await divider.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => regionSize(chat)).toBeGreaterThan(width);
        await waitForPanelGeometry(page);
        const resizedWidth = await regionSize(chat);
        await expectSideConversationFits(page);
        await layoutAndWait(paneHeader, "Minimize side panel", dashboard, chat);
        await expectContinuity();
        await layoutAndWait(paneHeader, /^(Side panel|Minimize side panel)$/, chat);
        await expectContinuity();
        await expect.poll(() => regionSize(chat)).toBeCloseTo(resizedWidth, 0);

        await page.reload();
        await page
          .locator('.sidebar-region--left [data-panel-slot="dashboard"][data-region="main"]')
          .waitFor();
        await expect.poll(() => regionSize(chat)).toBeCloseTo(resizedWidth, 0);
        await input.waitFor();
        await expectPaneHeaderGeometry(page, "left");
        await expectSideConversationFits(page);
        await openChatSidePanelType(page, "Terminal");
        const terminal = page.locator('[data-panel-slot="terminal"] openclaw-terminal-panel');
        await terminal.locator(".tp-session.is-current").click();
        await terminal.locator(".tp-host canvas").waitFor();
        await expect.poll(() => gateway.getRequests("terminal.open")).toHaveLength(1);
        await layoutAndWait(page, "Expand Terminal", terminal, dashboard);
        await layoutAndWait(page, "Restore split", dashboard);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
        const terminalCanvas = await terminal.locator(".tp-host canvas").elementHandle();
        await dockChatSidePanel(page, "left");
        await layoutAndWait(page, "Expand Terminal", terminal, dashboard);
        await layoutAndWait(page, "Restore split", dashboard);
        await dockChatSidePanel(page, "bottom");
        await layoutAndWait(page, "Expand Terminal", terminal, dashboard);
        await layoutAndWait(page, "Restore split", dashboard);
        await dockChatSidePanel(page, "right");
        expect(await terminalCanvas?.evaluate((canvas) => canvas.isConnected)).toBe(true);
        await terminalCanvas?.dispose();
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
        expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
      },
    );
  }, 120_000);

  it("retains an existing main Terminal through docking, keyboard selection and mobile round trips", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        permissions: ["local-network-access"],
      },
      async ({ page }) => {
        await page.addInitScript(
          ({ key, sessionKey: savedSessionKey }) => {
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarSessionLayouts: {
                  [savedSessionKey]: {
                    columns: [
                      {
                        id: "side-panel-column",
                        side: "right",
                        panels: [
                          { id: "terminal", slot: "terminal" },
                          { id: "dashboard", slot: "dashboard" },
                          { id: "conversation", slot: "conversation" },
                        ],
                        activePanelId: "dashboard",
                        width: 480,
                        height: 360,
                      },
                    ],
                    mainPanelId: "terminal",
                    open: true,
                  },
                },
              }),
            );
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
        );
        const gateway = await installBoardGateway(
          page,
          {
            terminalEnabled: true,
            communityInvite: false,
            featureMethods: [...chatMethods, "terminal.open"],
          },
          4,
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const terminalPanel = page.locator('[data-panel-slot="terminal"]');
        const terminal = terminalPanel.locator("openclaw-terminal-panel");
        const canvas = terminal.locator(".tp-host canvas");
        await terminal.locator(".tp-session.is-current").click();
        await canvas.waitFor();
        expect(await terminalPanel.getAttribute("data-region")).toBe("main");
        const mountedCanvas = await canvas.elementHandle();
        const input = widgetInput(page);
        await input.fill("Retained alongside main Terminal");
        const identity = await documentIdentity(input);
        const side = page.locator('[data-region-header="side"]');
        const chatTab = side.locator('.tabstrip-tab[data-tab-value="conversation"]');
        const dashboardTab = side.locator('.tabstrip-tab[data-tab-value="dashboard"]');
        await chatTab.click();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Retained chat beside main Terminal");
        await chatTab.focus();
        await page.keyboard.press("ArrowLeft");
        await input.waitFor();
        expect(await terminal.isVisible()).toBe(true);
        await page.keyboard.press("Enter");
        expect(await terminal.isVisible()).toBe(true);
        for (const dock of ["left", "bottom", "right"] as const) {
          await dockChatSidePanel(page, dock);
          await layoutAndWait(
            page,
            "Expand Dashboard",
            page.locator('[data-panel-slot="dashboard"]'),
            terminal,
          );
          await layoutAndWait(page, "Restore split", terminal);
          expect(await documentIdentity(input)).toBe(identity);
          expect(await input.inputValue()).toBe("Retained alongside main Terminal");
          expect(await composer.inputValue()).toBe("Retained chat beside main Terminal");
          expect(await mountedCanvas?.evaluate((element) => element.isConnected)).toBe(true);
        }
        await page.setViewportSize({ width: 400, height: 900 });
        await openChatPanels(page, "mobile");
        const host = page.locator(".chat-mobile-host");
        await host.getByRole("button", { name: "Panels", exact: true }).click();
        await side.locator('.tabstrip-tab[data-tab-value^="hosted:terminal:"]').click();
        await terminal.waitFor();
        await expect
          .poll(
            async () =>
              asOptionalRecord((await gateway.getRequests("terminal.resize")).at(-1)?.params)?.cols,
          )
          .toBeGreaterThan(30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
        await dashboardTab.click();
        await input.waitFor();
        await terminal.waitFor({ state: "hidden" });
        await side.locator('.tabstrip-tab[data-tab-value^="hosted:terminal:"]').click();
        await terminal.waitFor();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await terminalPanel.locator(".tp-host canvas").waitFor();
        await expect.poll(() => terminalPanel.getAttribute("data-region")).toBe("main");
        expect(await mountedCanvas?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await canvas.count()).toBe(1);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
        expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
        await mountedCanvas?.dispose();
      },
    );
  });
});
