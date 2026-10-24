import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createConfigSuite } from "./config-composer-fixtures.test-support.ts";
import { terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createConfigSuite("Control UI terminal panel layout");

const screenshotDirParent = process.env.OPENCLAW_TERMINAL_LAYOUT_SCREENSHOT_DIR?.trim();
function createLayoutCapture(page: Page, theme: string) {
  const screenshotDir = screenshotDirParent
    ? createControlUiE2eArtifactDir("terminal-panel-layout", screenshotDirParent)
    : undefined;
  return async (state: string) => {
    if (!screenshotDir) {
      return;
    }
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: path.join(screenshotDir, `${theme}-${state}-context.png`),
    });
    await page.locator("openclaw-terminal-panel .tp-header").screenshot({
      animations: "disabled",
      caret: "hide",
      path: path.join(screenshotDir, `${theme}-${state}-crop.png`),
    });
  };
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "toggles main content back to bottom and right in %s mode",
    async (theme) => {
      await suite.withPage(
        {
          colorScheme: theme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1280 },
        },
        async ({ page }) => {
          const capture = createLayoutCapture(page, theme);
          const gateway = await installMockGateway(page, {
            historyMessages: [
              chatMessage("assistant", "## Release workspace\n\n- CI checks are green"),
            ],
            featureMethods: ["terminal.open"],
            methodResponses: {
              "terminal.list": { sessions: [] },
              "terminal.open": terminalSession(`terminal-layout-${theme}`, {
                cwd: "/workspace/openclaw",
                shell: "/bin/zsh",
              }),
            },
            terminalEnabled: true,
          });

          await page.goto(`${suite.server.baseUrl}activity`);
          await waitForControlUiGatewayReady(page);
          await waitForControlUiTerminalReady(page);
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          await page.keyboard.press("Control+Backquote");
          await gateway.waitForRequest("terminal.open");
          const terminalOutput = "OpenClaw release workspace\r\n$ ";
          await gateway.emitGatewayEvent("terminal.data", {
            sessionId: `terminal-layout-${theme}`,
            seq: terminalOutput.length,
            data: terminalOutput,
          });

          const panel = page.locator("openclaw-terminal-panel");
          const surface = panel.locator(".tp");
          const fill = panel.getByRole("button", { name: "Fill main content area" });
          const bottom = panel.getByRole("button", { name: "Dock to bottom" });
          const right = panel.getByRole("button", { name: "Dock to right" });

          await expect.poll(() => surface.getAttribute("class")).toContain("tp--bottom");
          await capture("bottom");
          expect(await fill.count()).toBe(0);
          await right.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--right");
          await fill.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--main");
          await expect.poll(() => fill.count()).toBe(0);
          await capture("right-to-main");
          await bottom.click();
          const bottomRestored = await surface.getAttribute("class");
          await capture("bottom-restored");

          await right.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--right");
          await capture("right");
          await fill.click();
          await expect.poll(() => surface.getAttribute("class")).toContain("tp--main");
          await expect.poll(() => fill.count()).toBe(0);
          await capture("right-fill");
          await right.click();
          const rightRestored = await surface.getAttribute("class");
          await capture("right-restored");

          expect(bottomRestored).toContain("tp--bottom");
          expect(rightRestored).toContain("tp--right");
        },
      );
    },
  );
});
