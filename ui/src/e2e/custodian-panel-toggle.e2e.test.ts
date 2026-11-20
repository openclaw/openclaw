import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Ask OpenClaw panel toggle mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const WORK_SESSION_KEY = "agent:main:work";
const chatMethods = ["chat.metadata", "chat.startup", "chat.history", "chat.send"];
const contextOptions = { colorScheme: "dark", ...createControlUiE2eContextOptions() } as const;

async function openHome(page: Page, scenario: ControlUiMockGatewayScenario) {
  const gateway = await installMockGateway(page, { sessionKey: WORK_SESSION_KEY, ...scenario });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, WORK_SESSION_KEY));
  await page.locator(".sidebar-footer-bar__home").click();
  return { gateway, panel: page.locator("openclaw-assistant-panel") };
}

suite.define(() => {
  it("keeps Home available without an OpenClaw tab when openclaw.chat is not advertised", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const { gateway, panel } = await openHome(page, { featureMethods: chatMethods });
      await panel.getByRole("button", { name: "Home", exact: true }).waitFor();
      expect(await panel.getByRole("button", { name: "Ask OpenClaw", exact: true }).count()).toBe(
        0,
      );
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
    });
  });
});
