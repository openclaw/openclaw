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
const MOCK_SESSION_ID = "e2e-custodian-panel";
const WORK_SESSION_KEY = "agent:main:work";
const chatMethods = ["chat.metadata", "chat.startup", "chat.history", "chat.send"];
const contextOptions = { colorScheme: "dark", ...createControlUiE2eContextOptions() } as const;

async function openHome(page: Page, scenario: ControlUiMockGatewayScenario) {
  const gateway = await installMockGateway(page, { sessionKey: WORK_SESSION_KEY, ...scenario });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, WORK_SESSION_KEY));
  await page.locator(".sidebar-footer-bar__home").click();
  return { gateway, panel: page.locator("openclaw-assistant-panel") };
}

const custodianScenario: ControlUiMockGatewayScenario = {
  sessionKey: WORK_SESSION_KEY,
  sessions: [{ key: WORK_SESSION_KEY, label: "Main", kind: "direct", updatedAt: Date.now() }],
  featureMethods: [...chatMethods, "openclaw.chat", "openclaw.chat.history"],
  methodResponses: {
    "sessions.list": {
      cases: [
        // The work session does not match the Ask OpenClaw palette query.
        {
          match: { search: "Ask OpenClaw" },
          response: { count: 0, sessions: [] },
        },
      ],
    },
    "openclaw.chat": {
      sessionId: MOCK_SESSION_ID,
      reply: "Machine is healthy. Ask me anything.",
      action: "none",
    },
    "openclaw.chat.history": {
      turns: [{ role: "assistant", text: "Channel repaired.", at: 1_700_000_101_000 }],
    },
  },
};

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

  it("opens Ask OpenClaw beside Settings from the floating button", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      await installMockGateway(page, custodianScenario);
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const settingsSidebar = page.locator(".settings-sidebar");
      await settingsSidebar.getByRole("link", { name: "Appearance", exact: true }).waitFor();
      expect(await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).count()).toBe(0);

      const askOpenClaw = page
        .locator(".settings-ask-openclaw")
        .getByRole("button", { name: "Ask OpenClaw", exact: true });
      await askOpenClaw.click();
      const panel = page.locator("openclaw-assistant-panel > .assistant-panel");
      await panel.getByText("Channel repaired.").waitFor();
      expect(
        await panel
          .getByRole("button", { name: "Ask OpenClaw", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      // The dock opens beside the page; Settings stays put and the button steps aside.
      expect(new URL(page.url()).pathname).toBe("/settings/appearance");
      await askOpenClaw.waitFor({ state: "hidden" });

      await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await askOpenClaw.waitFor();
    });
  });

  it("opens the same OpenClaw conversation from Home and the palette", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const { panel } = await openHome(page, custodianScenario);
      const openClawTab = panel.getByRole("button", { name: "Ask OpenClaw", exact: true });
      await openClawTab.click();
      await panel.getByText("Channel repaired.").waitFor();

      await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await panel.getByText("Channel repaired.").waitFor({ state: "hidden" });

      await page.locator(".sidebar-brand__search").click();
      await page
        .locator("openclaw-command-palette")
        .getByPlaceholder("Search…")
        .fill("Ask OpenClaw");
      const paletteItem = page.getByRole("option", { name: "Ask OpenClaw", exact: true });
      await paletteItem.click();
      await panel.getByText("Channel repaired.").waitFor();
    });
  });
});
