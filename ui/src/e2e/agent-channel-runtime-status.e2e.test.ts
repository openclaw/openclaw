// Control UI E2E tests cover Agents channel runtime-status precedence.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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

// Minimal Gateway surface the agents Channels panel needs to render its section.
const channelStatusResponses = {
  "agents.list": {
    agents: [{ id: "main", name: "Main agent" }],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  },
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
    config: { agents: { entries: { main: { default: true } } } },
    hash: "hash-1",
    issues: [],
    raw: '{"agents":{"list":[{"id":"main"}]}}',
    valid: true,
  },
};

suite.define(() => {
  it("keeps an explicit stopped runtime in warning state when its API probe succeeds", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: channelStatusResponses,
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

  it("does not claim the channel list is empty while the first read is in flight", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: channelStatusResponses,
        deferredMethods: ["channels.status"],
      });

      await page.goto(`${suite.server.baseUrl}settings/agents/main/channels`);
      await page.getByRole("tab", { name: /^Channels/ }).click();
      await gateway.waitForRequest("channels.status");

      // The section button is the only surface that may describe an in-flight read.
      await expect.poll(() => page.getByRole("button", { name: /^Refreshing/ }).count()).toBe(1);
      await expect.poll(() => page.getByText("No channels found.").count()).toBe(0);
      await expect.poll(() => page.getByText("Load channels to see live status.").count()).toBe(0);
      await screenshot(page);
    });
  });

  it("does not stack the load hint or empty state under a failed read", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        defaultAgentId: "main",
        methodResponses: channelStatusResponses,
        deferredMethods: ["channels.status"],
      });

      await page.goto(`${suite.server.baseUrl}settings/agents/main/channels`);
      await page.getByRole("tab", { name: /^Channels/ }).click();
      await gateway.waitForRequest("channels.status");

      // Release every held read so the panel settles instead of staying in flight.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await gateway
          .rejectDeferred("channels.status", {
            code: "UNAVAILABLE",
            message: "channel status unavailable",
          })
          .catch(() => undefined);
        if ((await page.getByRole("button", { name: /^Refreshing/ }).count()) === 0) {
          break;
        }
      }

      await expect.poll(() => page.getByText("channel status unavailable").count()).toBe(1);
      await expect.poll(() => page.getByText("No channels found.").count()).toBe(0);
      await expect.poll(() => page.getByText("Load channels to see live status.").count()).toBe(0);
      await screenshot(page);
    });
  });
});
