import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Ask OpenClaw panel toggle mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const CUSTODIAN_SESSION_STORAGE_KEY = "openclaw.custodian.session.v1";
const MOCK_SESSION_ID = "e2e-custodian-panel";
const WORK_SESSION_KEY = "agent:main:work";
const chatMethods = ["chat.metadata", "chat.startup", "chat.history", "chat.send"];
const contextOptions = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} as const;

async function openHome(page: Page, scenario: ControlUiMockGatewayScenario) {
  const gateway = await installMockGateway(page, { sessionKey: WORK_SESSION_KEY, ...scenario });
  expect(
    (await page.goto(controlUiSessionUrl(suite.server.baseUrl, WORK_SESSION_KEY)))?.status(),
  ).toBe(200);
  await page.locator(".sidebar-brand__search").waitFor();
  await page.locator(".sidebar-identity-card").waitFor();
  await page.locator(".sidebar-footer-bar__home").click();
  return { gateway, panel: page.locator("openclaw-assistant-panel") };
}

function custodianGatewayScenario(): ControlUiMockGatewayScenario {
  return {
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
        turns: [
          { role: "user", text: "Fix my channel", at: 1_700_000_100_000 },
          { role: "assistant", text: "Channel repaired.", at: 1_700_000_101_000 },
        ],
      },
    },
  };
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

  it("opens OpenClaw from Home and the palette and reuses the persisted session id", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const { gateway, panel } = await openHome(page, custodianGatewayScenario());
      const openClawTab = panel.getByRole("button", { name: "Ask OpenClaw", exact: true });
      await openClawTab.waitFor();

      await openClawTab.click();
      await panel.getByText("Channel repaired.").waitFor();
      const chatRequest = await gateway.waitForRequest("openclaw.chat");
      const firstSessionId = (chatRequest.params as { sessionId?: string }).sessionId;
      expect(typeof firstSessionId).toBe("string");

      await panel.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await panel.getByText("Channel repaired.").waitFor({ state: "hidden" });

      await page.locator(".sidebar-brand__search").click();
      await page
        .locator("openclaw-command-palette")
        .getByPlaceholder("Search or start a task…")
        .fill("Ask OpenClaw");
      const paletteItem = page.getByRole("option", { name: "Ask OpenClaw", exact: true });
      await paletteItem.waitFor();
      await paletteItem.click();
      await panel.getByText("Channel repaired.").waitFor();

      const storedSessionId = await page.evaluate(
        (key) => window.localStorage.getItem(key),
        CUSTODIAN_SESSION_STORAGE_KEY,
      );
      expect(storedSessionId).toBe(MOCK_SESSION_ID);

      // Reload resets the request ring; this wait sees only post-reload traffic.
      await page.reload();
      await page.locator("openclaw-assistant-panel").getByText("Channel repaired.").waitFor();
      const reloadedRequest = await gateway.waitForRequest("openclaw.chat");
      expect((reloadedRequest.params as { sessionId?: string }).sessionId).toBe(MOCK_SESSION_ID);
    });
  });
});
