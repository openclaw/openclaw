import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { openChatPanels, selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { board } from "./chat-layout-fixtures.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard side-panel selection",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard";
const boardSnapshot = board(sessionKey);

suite.define(() => {
  it("uses Panels for the main Dashboard conversation without replacing its content", async () => {
    await suite.withPage(
      { viewport: { height: 900, width: 1440 }, colorScheme: "light" },
      async ({ page }) => {
        const widgetUrl = `${suite.server.baseUrl}__widget/panel-control`;
        await page.route(widgetUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: buildWidgetDocument(
              "Release overview",
              `<style>
          body {font:16px system-ui;background:#edf4f1;color:#183e32;margin:0;padding:36px}
          h1 {color:#183e32;font-size:36px;margin:12px 0 24px} section {display:flex;gap:24px;margin:32px 0}
          article {background:white;border-radius:12px;padding:24px;flex:1} strong {font-size:30px;display:block}
          input {background:white;color:#183e32;font:inherit;padding:12px;border:1px solid #afc6bc;border-radius:8px;width:80%}
          </style><main><p>DEMO · RELEASE WORKSPACE</p><h1>Release overview</h1>
          <p>Validation is complete. Two documentation items remain before the release.</p>
          <section><article><strong>18 / 20</strong>Checks complete</article><article><strong>2</strong>Open items</article></section>
          <label>Release note<br><input aria-label="Release note" placeholder="Write a release note"></label></main>`,
            ),
          }),
        );
        await installMockGateway(page, {
          sessionKey,
          agentModel: "example/demo-model",
          models: [
            { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
          ],
          sessions: [
            {
              key: sessionKey,
              agentId: "main",
              sessionId: "panel-control",
              kind: "direct",
              displayName: "Release workspace",
              updatedAt: 1,
              boardFace: "dashboard",
              boardPresentation: "split",
            },
          ],
          historyMessages: Array.from({ length: 20 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: [
              {
                type: "text",
                text:
                  index % 2
                    ? `Check ${index}: the release verification passed. The package and installation checks are complete. Keep the remaining documentation work visible in the dashboard.`
                    : `Review release item ${index}. Keep the draft and dashboard note while I compare the results.`,
              },
            ],
            timestamp: 1700000000000 + index,
          })),
          featureMethods: [
            "board.get",
            "chat.metadata",
            "chat.startup",
            "sessions.companion.state",
          ],
          methodResponses: {
            "board.get": {
              ...boardSnapshot,
              widgets: [
                {
                  name: "status",
                  tabId: "main",
                  title: "Release overview",
                  contentKind: "html",
                  sizeW: 12,
                  sizeH: 6,
                  position: 0,
                  grantState: "none",
                  revision: 1,
                  frameUrl: widgetUrl,
                },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const draft = "Keep this release draft while I inspect the dashboard.";
        await composer.fill(draft);
        const note = page
          .frameLocator('[data-widget-name="status"] iframe')
          .getByRole("textbox", { name: "Release note" });
        await note.fill("Documentation review next");
        const frame = page.locator('[data-widget-name="status"] iframe');
        const frameHandle = await frame.elementHandle();
        const composerHandle = await composer.elementHandle();
        await selectChatLayoutAction(page, /^Swap /);
        const dashboard = page.locator('[data-panel-slot="dashboard"][data-region="main"]');
        const conversation = page.locator('.sidebar-region__primary[data-region="side"]');
        await dashboard.waitFor();
        await conversation.waitFor();
        const duplicateControls = await page.locator(".chat-pane__chat-toggle").count();
        const panels = page.locator('.sidebar-region__panels-toggle button[aria-label="Panels"]');
        expect(await panels.count()).toBe(1);
        const thread = page.locator(".chat-thread");
        await thread.hover();
        await page.mouse.wheel(0, -300);
        await waitForLayoutSettled(page, ".sidebar-region");
        const divider = page.locator(".sidebar-column__divider[role=separator]");
        await divider.focus();
        await page.keyboard.press("ArrowLeft");
        await waitForLayoutSettled(page, ".sidebar-region__primary");
        const width = (await conversation.boundingBox())!.width;
        const scrollTop = await thread.evaluate((element) => element.scrollTop);
        const capture = async (state: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          for (const colorScheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme });
            await expect
              .poll(() => page.locator("html").getAttribute("data-theme-mode"))
              .toBe(colorScheme);
            await page.mouse.move(0, 0);
            await waitForLayoutSettled(page, ".sidebar-region");
            await page.screenshot({ path: `${suite.artifactDir}/${state}-${colorScheme}.png` });
            const region = (await page.locator(".sidebar-region").boundingBox())!;
            await page.screenshot({
              path: `${suite.artifactDir}/${state}-${colorScheme}-header.png`,
              clip: { ...region, height: 56 },
            });
          }
        };
        await panels.click();
        await conversation.waitFor({ state: "hidden" });
        expect(await panels.getAttribute("aria-expanded")).toBe("false");
        await capture("dashboard-main-closed");
        await panels.focus();
        await page.keyboard.press("Enter");
        await conversation.waitFor();
        expect(await panels.getAttribute("aria-expanded")).toBe("true");
        expect(await panels.evaluate((element) => element === document.activeElement)).toBe(true);
        await capture("dashboard-main-chat");
        await panels.dblclick();
        await conversation.waitFor();
        expect(await panels.getAttribute("aria-expanded")).toBe("true");
        expect(await composer.inputValue()).toBe(draft);
        expect(await note.inputValue()).toBe("Documentation review next");
        expect(await frame.evaluate((element, previous) => element === previous, frameHandle)).toBe(
          true,
        );
        expect(
          await composer.evaluate((element, previous) => element === previous, composerHandle),
        ).toBe(true);
        await waitForLayoutSettled(page, ".sidebar-region__primary");
        expect((await conversation.boundingBox())!.width).toBeCloseTo(width, 0);
        expect(await thread.evaluate((element) => element.scrollTop)).toBe(scrollTop);
        await selectChatLayoutAction(page, "Focus");
        await conversation.waitFor({ state: "hidden" });
        await panels.click();
        await conversation.waitFor();
        expect(await composer.inputValue()).toBe(draft);
        await panels.click();
        await page.reload();
        await dashboard.waitFor();
        await conversation.waitFor({ state: "hidden" });
        expect(await panels.getAttribute("aria-expanded")).toBe("false");
        await panels.click();
        await conversation.waitFor();
        expect(await composer.inputValue()).toBe(draft);
        await page.keyboard.press("ControlOrMeta+Shift+S");
        await page.locator('[data-panel-slot="companion"]:not([hidden])').waitFor();
        await dashboard.waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+S");
        await conversation.waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator(".agent-chat__header--mobile").waitFor();
        const mobileHost = page.locator(".chat-mobile-host");
        await mobileHost.waitFor();
        await mobileHost
          .locator(".chat-mobile-host__header")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await mobileHost.waitFor({ state: "hidden" });
        await openChatPanels(page, "mobile");
        await mobileHost.waitFor();
        expect(await composer.inputValue()).toBe(draft);
        await page.setViewportSize({ width: 1440, height: 900 });
        await dashboard.waitFor();
        await conversation.waitFor();
        expect(await composer.inputValue()).toBe(draft);
        await selectChatLayoutAction(page, /^Swap /);
        await page.locator('.sidebar-region__primary[data-region="main"]').waitFor();
        await page.locator('[data-panel-slot="dashboard"][data-region="side"]').waitFor();
        expect(await composer.inputValue()).toBe(draft);
        expect(duplicateControls).toBe(0);
      },
    );
  });

  it.each([
    { main: "Chat", side: "Side chat", view: "split" },
    { main: "Chat", side: "Files", view: "split" },
    { main: "Dashboard", side: "Side chat", view: "split" },
    { main: "Dashboard", side: "Files", view: "split" },
    { main: "Chat", side: "Files", view: "closed side" },
    { main: "Chat", side: "Files", view: "focused Files" },
  ])(
    "retains $main main and $side in $view after dashboard reload",
    async ({ main, side, view }) => {
      await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            {
              key: sessionKey,
              agentId: "main",
              sessionId: "dashboard-active-panel",
              kind: "direct",
              updatedAt: 1,
              boardFace: "dashboard",
              boardPresentation: "split",
            },
          ],
          featureMethods: [
            "board.get",
            "chat.metadata",
            "chat.startup",
            "sessions.companion.state",
          ],
          methodResponses: {
            "board.get": boardSnapshot,
            "sessions.companion.state": {
              exchanges: [
                {
                  question: "What should I check?",
                  answer: "Keep this side conversation visible.",
                  ts: 1_000,
                },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        await page.locator(".board-session-surface").waitFor();
        if (main === "Dashboard") {
          await selectChatLayoutAction(page, /^Swap /);
        }
        const mainPanel = page.locator(
          main === "Dashboard"
            ? '[data-panel-slot="dashboard"][data-region="main"]'
            : '.sidebar-region__primary[data-region="main"]',
        );
        await mainPanel.waitFor();
        await openChatSidePanelType(page, side);
        const selectedTab = page.getByRole("tab", { name: side, exact: true });
        const answer = page
          .locator("openclaw-chat-session-rail")
          .getByText("Keep this side conversation visible.", { exact: true });
        await expect.poll(() => selectedTab.getAttribute("aria-selected")).toBe("true");
        if (side === "Side chat") {
          await answer.waitFor();
        }
        if (view === "closed side") {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        } else if (view === "focused Files") {
          await selectChatLayoutAction(page, "Focus");
        }

        await page.reload();
        if (view === "focused Files") {
          await page.locator('[data-panel-slot="workspace"][data-region="side"]').waitFor();
          await mainPanel.waitFor({ state: "attached" });
          await expect.poll(() => mainPanel.isVisible()).toBe(false);
        } else {
          await mainPanel.waitFor();
        }
        if (view === "closed side") {
          await expect.poll(() => page.locator(".sidebar-region--open").count()).toBe(0);
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        } else if (view === "focused Files") {
          await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
          await selectChatLayoutAction(page, "Restore split");
          await mainPanel.waitFor();
        }
        await selectedTab.waitFor();
        await expect.poll(() => selectedTab.getAttribute("aria-selected")).toBe("true");
        if (side === "Side chat") {
          await answer.waitFor();
        }
      });
    },
  );

  it("restores the saved main and side selection on ordinary dashboard revisits", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storageKey }) => {
          const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
            string,
            unknown
          >;
          settings.boardSessionViews = { [key]: { activeTabId: "main" } };
          const sidebarSessionLayouts =
            settings.sidebarSessionLayouts && typeof settings.sidebarSessionLayouts === "object"
              ? (settings.sidebarSessionLayouts as Record<string, unknown>)
              : {};
          settings.sidebarSessionLayouts = {
            ...sidebarSessionLayouts,
            [key]: sidebarSessionLayouts[key] ?? {
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
                  height: 360,
                  width: 480,
                },
              ],
              dock: "right",
              mainPanelId: "terminal",
              open: true,
            },
          };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        { key: sessionKey, storageKey: settingsKey },
      );
      await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "terminal.open"],
        methodResponses: { "board.get": boardSnapshot },
        terminalEnabled: true,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      await page.locator(".board-session-surface").waitFor();
      const terminal = page.locator('[data-panel-slot="terminal"][data-region="main"]');
      const dashboard = page.getByRole("tab", { name: "Dashboard", exact: true });
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);

      await page.reload();
      await page.locator(".board-session-surface").waitFor();
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
    });
  });
});
