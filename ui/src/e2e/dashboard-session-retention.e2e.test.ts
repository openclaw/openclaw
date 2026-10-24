import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained dashboard sessions",
  startServerBeforeBrowser: true,
});

const alphaKey = "agent:main:dashboard-alpha";
const viewport = { height: 900, width: 1280 };
const featureMethods = ["board.get", "chat.metadata", "chat.startup"];
const gatewayDefaults = { sessionKey: alphaKey, featureMethods };
const emptyBoard = { sessionKey: alphaKey, revision: 1, tabs: [], widgets: [] };
const populatedBoard = {
  ...emptyBoard,
  tabs: [{ tabId: "alpha-main", title: "alpha main", position: 0, chatDock: "right" }],
};

suite.define(() => {
  it("opens an empty task dashboard without editing the draft and preserves its chosen layout", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...gatewayDefaults,
        methodResponses: { "board.get": emptyBoard },
        deferredMethods: ["board.get"],
      });
      await page.goto(new URL(controlUiSessionPath(alphaKey), suite.server.baseUrl).href);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft = "Review the release checklist.";
      await composer.fill(draft);
      await openChatSidePanelType(page, "Dashboard");
      const dashboard = page.locator('[data-panel-slot="dashboard"]');
      const boardView = dashboard.locator("openclaw-board-view");
      await dashboard.getByRole("status").waitFor();
      expect(await composer.inputValue()).toBe(draft);
      await gateway.rejectDeferred("board.get", {
        code: "UNAVAILABLE",
        message: "Dashboard temporarily unavailable",
        retryable: false,
      });
      await dashboard.getByRole("alert").waitFor();
      expect(await dashboard.getByRole("alert").textContent()).toContain(
        "Dashboard temporarily unavailable",
      );
      expect(await dashboard.locator('[data-test-id="board-empty"]').count()).toBe(0);
      await gateway.deferNext("board.get");
      await gateway.emitGatewayEvent("board.changed", { sessionKey: alphaKey });
      await expect.poll(async () => (await gateway.getRequests("board.get")).length).toBe(2);
      await gateway.resolveDeferred("board.get");
      await dashboard.locator('[data-test-id="board-empty"]').waitFor();
      const board = await boardView.elementHandle();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        await dashboard.waitFor({ state: "hidden" });
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        await dashboard.locator('[data-test-id="board-empty"]').waitFor();
        expect(await composer.inputValue()).toBe(draft);
      }
      await selectChatLayoutAction(page, /^Swap /);
      await selectChatLayoutAction(page, "Focus");
      await composer.waitFor({ state: "hidden" });
      await gateway.setMethodResponse("board.get", populatedBoard);
      await gateway.emitGatewayEvent("board.changed", { sessionKey: alphaKey });
      await page.locator('[data-board-tab-id="alpha-main"]').waitFor();
      expect(await composer.isVisible()).toBe(false);
      expect(await boardView.evaluate((element, previous) => element === previous, board)).toBe(
        true,
      );
      await selectChatLayoutAction(page, "Restore split");
      await composer.waitFor();
      expect(await composer.inputValue()).toBe(draft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
