import type { Page } from "playwright";
import { expect, it } from "vitest";
import { emptyPairingSnapshot } from "../pages/channels/pairing.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSchema, objectSchema } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Channels explicit save",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const PARTIAL = "123456:PARTIAL";
const config = {
  channels: { telegram: { enabled: true, dmPolicy: "pairing" } },
};
const snapshot = {
  config,
  sourceConfig: config,
  runtimeConfig: config,
  raw: JSON.stringify(config),
  hash: "channel-config",
  configRevisionHash: "channel-config",
  appliedConfigHash: "channel-config",
  issues: [],
  valid: true,
};
const schema = configSchema(
  objectSchema("", {
    channels: objectSchema("", {
      telegram: objectSchema("Telegram", {
        botToken: { type: "string", title: "Bot Token" },
      }),
    }),
  }),
  { "channels.telegram.botToken": { sensitive: true, advanced: false } },
);

async function openChannels(page: Page) {
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "config.patch"],
    methodResponses: {
      "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
      "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
      "channels.status": {
        ts: Date.now(),
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channels: { telegram: { configured: true, running: true, connected: true } },
        channelAccounts: {},
        channelDefaultAccountId: {},
      },
      "channels.pairing.list": emptyPairingSnapshot(),
      "config.get": snapshot,
      "config.schema": schema,
      "config.patch": { ok: true, config, hash: "channel-config" },
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/profile`);
  await page.getByRole("link", { name: "Channels", exact: true }).first().click();
  await page.locator(".channels-item").filter({ hasText: "Telegram" }).first().click();
  const detail = page.locator(".channels-detail");
  const token = detail.locator('input[type="password"]').first();
  await token.waitFor();
  return { gateway, detail, token };
}

suite.define(() => {
  it("holds a partial credential until Save, across closing and leaving", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page);
      const writes = async () =>
        (await gateway.getRequests("config.set")).length +
        (await gateway.getRequests("config.patch")).length;
      const status = detail.getByRole("status");

      await token.fill(PARTIAL);
      await expect.poll(() => status.textContent()).toBe("Unsaved changes");
      await expect.poll(() => status.isVisible()).toBe(true);
      await page.waitForTimeout(1500);
      expect(await writes()).toBe(0);

      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await writes()).toBe(0);

      await page.goBack();
      const review = page.getByRole("button", { name: "Review", exact: true });
      await review.waitFor();
      expect(await writes()).toBe(0);
      await review.click();
      await token.waitFor();
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await writes()).toBe(0);

      await gateway.deferNext("config.patch");
      await detail.getByRole("button", { name: "Save", exact: true }).click();
      const request = await gateway.waitForRequest("config.patch");
      const params = request.params as { raw: string; baseHash: string };
      expect(params.baseHash).toBe("channel-config");
      expect(JSON.parse(params.raw)).toEqual({ channels: { telegram: { botToken: PARTIAL } } });
      await gateway.resolveDeferred("config.patch", {
        config: { channels: { telegram: { ...config.channels.telegram, botToken: PARTIAL } } },
        hash: "channel-config-2",
      });
      await expect.poll(() => status.textContent()).toBe("Saved");
    });
  });

  it("marks the row after a plain return, without reopening the channel", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page);
      await token.fill(PARTIAL);
      await page.goBack();
      await page.getByRole("button", { name: "Review", exact: true }).waitFor();
      await page.getByRole("link", { name: "Channels", exact: true }).first().click();

      const row = page.locator(".channels-item").filter({ hasText: "Telegram" }).first();
      await expect.poll(() => row.textContent()).toContain("Unsaved changes");
      expect(await detail.count()).toBe(0);

      await row.click();
      await token.waitFor();
      expect(await token.inputValue()).toBe(PARTIAL);
      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect.poll(() => row.textContent()).not.toContain("Unsaved changes");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    });
  });

  it("keeps the edit when Save fails, and discards it only when asked", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page);
      await token.fill(PARTIAL);
      await gateway.deferNext("config.patch");
      await detail.getByRole("button", { name: "Save", exact: true }).click();
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "Bot token format is invalid",
      });
      await expect.poll(() => detail.getByRole("alert").textContent()).toContain("invalid");
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await detail.getByRole("status").textContent()).toBe("Unsaved changes");
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect.poll(() => detail.count()).toBe(0);
      await page.locator(".channels-item").filter({ hasText: "Telegram" }).first().click();
      await token.waitFor();
      expect(await token.inputValue()).not.toBe(PARTIAL);
      expect(await detail.getByRole("status").count()).toBe(0);
    });
  });
});
