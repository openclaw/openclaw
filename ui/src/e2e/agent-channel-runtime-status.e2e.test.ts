// Control UI E2E tests cover Agents channel runtime-status precedence.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { agentRoster as createAgentRoster } from "./agent-roster.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Agents channel status",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("channel-runtime-status");
  }
});

async function screenshot(page: Page) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, "after.png"),
  });
}

suite.define(() => {
  it("keeps a failed status read inside the phone warning without losing the previous row", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "agents.list",
            "channels.status",
            "config.get",
          ],
          methodResponses: {
            "agents.list": createAgentRoster({ main: "Main agent" }, "main", "agent"),
            "channels.status": {
              ts: 1,
              channelOrder: ["discord"],
              channelLabels: { discord: "Discord" },
              channels: {},
              channelAccounts: {},
              channelDefaultAccountId: {},
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/agents/main/channels");
        const panel = page.getByRole("tabpanel");
        const row = panel.getByText("Discord", { exact: true });
        await row.waitFor();
        const message =
          "Could not read channel status for com.acme.regionaloperationscalendaranddeliverynotificationservice.";
        await gateway.setMethodResponse("channels.status", {
          __mockError: { code: "UNAVAILABLE", message, retryable: true },
        });
        await panel.getByRole("button", { name: "Refresh", exact: true }).tap();
        const alert = panel.getByRole("alert").filter({ hasText: message });
        await alert.waitFor();
        expect(await row.isVisible()).toBe(true);
        expect(
          await alert.evaluate((element) => {
            const text = document.createRange();
            text.selectNodeContents(element);
            return text.getBoundingClientRect().right <= element.getBoundingClientRect().right;
          }),
        ).toBe(true);
      },
    );
  });

  it("keeps an explicit stopped runtime in warning state when its API probe succeeds", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.list",
          "channels.status",
          "config.get",
        ],
        methodResponses: {
          "agents.list": createAgentRoster({ main: "Main agent" }, "main", "agent"),
          "channels.status": {
            ts: Date.now(),
            channelOrder: ["discord"],
            channelLabels: { discord: "Discord" },
            channelMeta: [{ id: "discord", label: "Discord", detailLabel: "Discord Bot" }],
            channels: {},
            channelAccounts: {
              discord: [
                {
                  accountId: "default",
                  configured: true,
                  connected: false,
                  enabled: true,
                  probe: { ok: true },
                  running: false,
                },
              ],
            },
            channelDefaultAccountId: { discord: "default" },
          },
          "config.get": {
            config: { agents: { entries: { main: {} } } },
            hash: "hash-1",
            issues: [],
            raw: '{"agents":{"entries":{"main":{}}}}',
            valid: true,
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/channels`);
      expect(response?.status()).toBe(200);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/main/channels");
      await page.getByRole("tab", { name: /^Channels/ }).click();

      const discordRow = page.locator(".settings-row").filter({ hasText: "Discord" });
      await expect.poll(() => discordRow.count()).toBe(1);

      const status = discordRow.locator(".settings-status");
      await expect.poll(async () => (await status.textContent())?.trim()).toBe("0/1 connected");
      await expect
        .poll(async () => await status.getAttribute("class"))
        .toContain("settings-status--warn");
      await screenshot(page);
    });
  });
});
