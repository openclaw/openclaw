import path from "node:path";
import type { BoardSnapshot } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "single fullscreen widget chrome" });
const sessionKey = "agent:main:dashboard:42d71fe0-1234-4567-8901-234567890abc";
const chrome =
  ".board-widget__bar, .board-widget__drag-handle, .board-widget__resize-handle, .board-widget__grant-dot";
const menuSelector = "openclaw-chat-header-session-menu";

function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    sessionKey,
    revision: 1,
    tabs: [
      { tabId: "main", title: "Overview", position: 0, chatDock: "right" },
      { tabId: "research", title: "Research", position: 1, chatDock: "right" },
    ],
    widgets: [
      {
        name: "release-status",
        tabId: "main",
        title: "Release status",
        contentKind: "html",
        sizeW: 12,
        sizeH: 8,
        position: 0,
        grantState: "granted",
        revision: 1,
        declared: { tools: ["health"], netOrigins: [] },
      },
    ],
    ...overrides,
  };
}

async function openDashboard(page: Page, source: BoardSnapshot, readOnly = false) {
  const frameUrl = new URL("__widget/solo-release-status", suite.server.baseUrl).href;
  await page.route(frameUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: buildWidgetDocument(
        "Release status",
        `<style>body{margin:0;background:#102820;color:#ecfff4;font:16px system-ui;min-height:420px}main{padding:36px}h1{font-size:44px;margin:12px 0}p{color:#b0cebc}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #668577}input{display:block;margin-top:28px}button{background:#b7fac8;color:#102820}</style><main><p>RELEASE OVERVIEW</p><h1>Ready for the next release.</h1><p>All checks complete. One uninterrupted dashboard.</p><button onclick="this.textContent='Status refreshed'">Refresh status</button><input aria-label="Release note" placeholder="Add a local note"></main>`,
      ),
    }),
  );
  const board = { ...source, widgets: source.widgets.map((widget) => ({ ...widget, frameUrl })) };
  const gateway = await installMockGateway(page, {
    sessionKey,
    agentModel: "gpt-4.1",
    sessions: [
      {
        key: sessionKey,
        agentId: "main",
        sessionId: "solo-widget-session",
        kind: "direct",
        displayName: "Release overview",
        boardFace: "dashboard",
        boardPresentation: "expanded",
        updatedAt: 1,
        model: "gpt-4.1",
        modelProvider: "openai",
      },
    ],
    operatorScopes: readOnly
      ? ["operator.read"]
      : ["operator.read", "operator.write", "operator.approvals"],
    featureMethods: [
      "board.get",
      "board.update",
      "board.widget.grant",
      "chat.metadata",
      "chat.startup",
    ],
    methodResponses: { "board.get": board },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
  await gateway.waitForRequest("board.get");
  await page.locator(".board-session-surface").waitFor();
  await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
  await page.locator(".chat-header-session-menu__trigger").waitFor();
  return { gateway, board };
}

async function showHeaderMenu(page: Page, input: "pointer" | "keyboard" = "pointer") {
  const menu = page.locator(menuSelector);
  const dropdown = menu.locator("wa-dropdown");
  // The heading is visible before the menu finishes scaling. Observe this opening,
  // not a previous one, before Playwright chooses an action's click coordinates.
  await dropdown.evaluate((element) => {
    element.removeAttribute("data-e2e-after-show");
    element.addEventListener(
      "wa-after-show",
      () => element.setAttribute("data-e2e-after-show", ""),
      { once: true },
    );
  });
  const trigger = page.locator(".chat-header-session-menu__trigger");
  if (input === "keyboard") {
    await trigger.focus();
    await page.keyboard.press("Enter");
  } else {
    await trigger.click();
  }
  await expect.poll(() => dropdown.getAttribute("data-e2e-after-show")).not.toBeNull();
  await menu.locator(".board-widget__page-menu-heading").waitFor();
  return menu;
}

async function updateBoard(gateway: MockGatewayControls, board: BoardSnapshot) {
  await gateway.setMethodResponse("board.get", board);
  await gateway.emitGatewayEvent("board.changed", { sessionKey });
}

suite.define(() => {
  it("relocates real widget actions, retains the frame, and restores split and multi-widget controls", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const { gateway, board } = await openDashboard(page, snapshot());
        const widget = page.locator('[data-widget-name="release-status"]');
        const frame = widget.locator("iframe");
        const note = frame.contentFrame().getByRole("textbox", { name: "Release note" });
        await note.fill("Keep this local draft");
        const original = await frame.elementHandle();
        await widget.focus();
        expect(await widget.locator(chrome).count()).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "candidate-expanded.png") });
        await showHeaderMenu(page);
        await page.keyboard.press("Escape");
        const menu = await showHeaderMenu(page, "keyboard");
        const capabilities = menu.getByRole("note", { name: "Active widget capabilities" });
        await capabilities.waitFor({ state: "visible" });
        expect(await capabilities.textContent()).toContain("Tool: health");
        await menu.locator('[value="board-widget:resize:xl"]').waitFor();
        const itemFonts = await menu.evaluate((element) =>
          Array.from(
            element.querySelectorAll("wa-dropdown-item"),
            (item) => getComputedStyle(item).font,
          ),
        );
        expect([...new Set(itemFonts)]).toEqual([expect.any(String)]);
        await page.screenshot({ path: path.join(suite.artifactDir, "candidate-header-menu.png") });
        const resized = { ...board, revision: 2 };
        await gateway.setMethodResponse("board.update", resized);
        await menu.locator('[value="board-widget:resize:xl"]').click();
        const resize = await gateway.waitForRequest("board.update");
        expect(resize.params).toMatchObject({
          sessionKey,
          agentId: "main",
          ops: [
            {
              kind: "widget_resize",
              name: "release-status",
              sizeW: 12,
              sizeH: 8,
              heightMode: "fixed",
            },
          ],
        });
        expect(await frame.evaluate((element, previous) => element === previous, original)).toBe(
          true,
        );
        expect(await note.inputValue()).toBe("Keep this local draft");
        await page.getByRole("button", { name: "Restore split", exact: true }).click();
        await widget.locator(".board-widget__menu-trigger").waitFor({ state: "attached" });
        await widget.focus();
        await expect
          .poll(() =>
            widget
              .locator(".board-widget__bar")
              .evaluate((element) => getComputedStyle(element).visibility),
          )
          .toBe("visible");
        expect(await page.locator(menuSelector + ' [value^="board-widget:"]').count()).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "candidate-split.png") });
        await page
          .locator(".chat-pane__header")
          .getByRole("button", { name: "Focus", exact: true })
          .click();
        await expect.poll(() => widget.locator(chrome).count()).toBe(0);
        const multiple = {
          ...board,
          revision: 3,
          widgets: [
            ...board.widgets,
            {
              ...board.widgets[0]!,
              name: "second",
              title: "Second widget",
              position: 1,
              grantState: "pending" as const,
            },
          ],
        };
        await updateBoard(gateway, multiple);
        await expect.poll(() => page.locator(".board-widget").count()).toBe(2);
        await widget.locator(".board-widget__menu-trigger").waitFor({ state: "attached" });
        expect(await page.locator(menuSelector + ' [value^="board-widget:"]').count()).toBe(0);
        expect(await frame.evaluate((element, previous) => element === previous, original)).toBe(
          true,
        );
        expect(await note.inputValue()).toBe("Keep this local draft");
        await updateBoard(gateway, {
          ...board,
          revision: 4,
          widgets: [
            board.widgets[0]!,
            {
              ...board.widgets[0]!,
              name: "research-widget",
              tabId: "research",
              title: "Research widget",
            },
          ],
        });
        await expect.poll(() => widget.locator(chrome).count()).toBe(0);
        await page.getByRole("tab", { name: "Research", exact: true }).click();
        await page.locator('[data-widget-name="research-widget"]').waitFor();
        const researchMenu = await showHeaderMenu(page);
        expect(
          await researchMenu.locator(".board-widget__page-menu-heading").textContent(),
        ).toContain("Research widget");
        await gateway.setMethodResponse("board.update", { ...board, revision: 5 });
        await researchMenu.locator('[value="board-widget:remove"]').click();
        const remove = await gateway.waitForRequest("board.update", { after: 1 });
        expect(remove.params).toMatchObject({
          sessionKey,
          ops: [{ kind: "widget_remove", name: "research-widget" }],
        });
        await page.locator('[data-test-id="board-empty"]').waitFor();
        expect(await page.locator(menuSelector + ' [value^="board-widget:"]').count()).toBe(0);
        await page.getByRole("tab", { name: "Overview", exact: true }).click();
        await frame.waitFor();
        expect(await frame.evaluate((element, previous) => element === previous, original)).toBe(
          true,
        );
        expect(await note.inputValue()).toBe("Keep this local draft");
      },
    );
  });

  it("keeps pending decisions and failed header operations visible in the fullscreen widget", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const initial = snapshot();
        initial.widgets[0]!.grantState = "pending";
        const { gateway, board } = await openDashboard(page, initial);
        const widget = page.locator('[data-widget-name="release-status"]');
        await widget.getByRole("button", { name: "Allow", exact: true }).waitFor();
        expect(await widget.locator(chrome).count()).toBe(0);
        const rejected = structuredClone(board);
        rejected.revision = 2;
        for (const item of rejected.widgets) {
          item.grantState = "rejected";
        }
        await gateway.setMethodResponse("board.widget.grant", rejected);
        await widget.getByRole("button", { name: "Reject", exact: true }).click();
        expect((await gateway.waitForRequest("board.widget.grant")).params).toMatchObject({
          name: "release-status",
          decision: "rejected",
        });
        await widget.locator('[data-test-id="board-rejected"]').waitFor();
        const menu = await showHeaderMenu(page);
        await gateway.setMethodResponse("board.update", {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic dashboard write failure" },
        });
        await gateway.deferNext("board.get", { sessionKey });
        await menu.locator('[value="board-widget:remove"]').click();
        await gateway.waitForRequest("board.update");
        await widget.locator('[data-test-id="board-widget-action-error"]').waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "candidate-action-error.png") });
        expect(await widget.locator(chrome).count()).toBe(0);
      },
    );
  });

  it.each([false, true])(
    "keeps the touch fullscreen widget clear with readOnly=%s",
    async (readOnly) => {
      await suite.withPage(
        {
          viewport: { width: 393, height: 852 },
          hasTouch: true,
          isMobile: true,
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const { gateway } = await openDashboard(page, snapshot(), readOnly);
          const widget = page.locator('[data-widget-name="release-status"]');
          await widget
            .locator("iframe")
            .contentFrame()
            .getByRole("textbox", { name: "Release note" })
            .waitFor();
          expect(
            await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
          ).toBe(false);
          expect(await widget.locator(chrome).count()).toBe(0);
          const menu = await showHeaderMenu(page);
          expect(await menu.locator('[value="board-widget:remove"]').count()).toBe(
            readOnly ? 0 : 1,
          );
          expect(await gateway.getRequests("board.update")).toHaveLength(0);
          await page.screenshot({
            path: path.join(
              suite.artifactDir,
              readOnly ? "candidate-touch-readonly.png" : "candidate-touch-menu.png",
            ),
          });
        },
      );
    },
  );
});
