import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createConfigSuite } from "./config-composer-fixtures.test-support.ts";
import { terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createConfigSuite("Control UI terminal panel layout");

suite.define(() => {
  it("offers main content from the right dock and restores the bottom dock", () =>
    suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": terminalSession("layout"),
          },
          terminalEnabled: true,
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiGatewayReady(page);
        await waitForControlUiTerminalReady(page);
        await page.keyboard.press("Control+Backquote");
        await gateway.waitForRequest("terminal.open");
        await gateway.emitGatewayEvent("terminal.data", {
          sessionId: "layout",
          seq: 5,
          data: "ready",
        });

        const panel = page.locator("openclaw-terminal-panel");
        const surface = panel.locator(".tp");
        const fill = panel.getByRole("button", { name: "Fill main content area" });
        const expectDock = (dock: string) =>
          expect.poll(() => surface.getAttribute("class")).toContain(`tp--${dock}`);
        await expectDock("bottom");
        expect(await fill.count()).toBe(0);
        await panel.getByRole("button", { name: "Dock to right" }).click();
        await expectDock("right");
        await fill.click();
        await expectDock("main");
        await expect.poll(() => fill.count()).toBe(0);
        await panel.getByRole("button", { name: "Dock to bottom" }).click();
        await expectDock("bottom");
      },
    ));
});
